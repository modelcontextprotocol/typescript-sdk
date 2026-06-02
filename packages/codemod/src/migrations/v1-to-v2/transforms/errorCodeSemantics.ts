import type { BinaryExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { error, warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isImportedFromMcp } from '../../../utils/importUtils.js';
import { ERROR_CODE_SDK_MEMBERS } from '../mappings/symbolMap.js';

/**
 * In v1, `ErrorCode.RequestTimeout` and `ErrorCode.ConnectionClosed` were numeric
 * members of the protocol error enum and were raised on `McpError`. In v2 they moved
 * to `SdkErrorCode` — a STRING enum — and are raised on `SdkError`, while protocol
 * errors became `ProtocolError` with `ProtocolErrorCode`.
 *
 * The symbol rename transform updates the enum references, but a check like
 *
 *     e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout
 *
 * still compiles under loose typing and NEVER matches at runtime, because v2 raises
 * timeouts/disconnects as `SdkError`, not `ProtocolError`. This transform rewrites the
 * `instanceof` side of such checks to `SdkError` where that is safe, and emits
 * diagnostics where it is not:
 *
 * - `subject instanceof ProtocolError/McpError` guarding a comparison against a moved
 *   member → guard rewritten to `subject instanceof SdkError` (import added).
 * - comparison against a moved member with no detectable `instanceof` guard → warning
 *   to verify the subject is checked as `SdkError`.
 * - `instanceof` guard against an unrecognized class → error with the exact manual fix.
 * - `switch` over `x.code` mixing `SdkErrorCode` and `ProtocolErrorCode` cases → error
 *   (the enums live on different error classes in v2; the switch must be split).
 * - object literals keyed by a moved member → warning (`SdkErrorCode` is a string enum;
 *   previously-numeric map keys are now strings).
 *
 * Both the post-rename (`SdkErrorCode.X`) and pre-rename (`ErrorCode.X`) spellings are
 * recognized, so the transform composes with the symbol rename transform in either
 * order; it never rewrites the enum reference itself.
 */

const MOVED_MEMBER_ENUMS = new Set(['SdkErrorCode', 'ErrorCode']);
const V1_ERROR_CLASSES = new Set(['ProtocolError', 'McpError']);

export const errorCodeSemanticsTransform: Transform = {
    name: 'Error code semantics',
    id: 'error-code-semantics',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        const filePath = sourceFile.getFilePath();
        let changesCount = 0;
        let needsSdkErrorImport = false;

        // Collect first, mutate after — mutating while iterating invalidates descendants.
        const movedMemberAccesses: Node[] = [];
        sourceFile.forEachDescendant(node => {
            if (!Node.isPropertyAccessExpression(node)) return;
            const expr = node.getExpression();
            if (!Node.isIdentifier(expr)) return;
            if (!MOVED_MEMBER_ENUMS.has(expr.getText())) return;
            if (!ERROR_CODE_SDK_MEMBERS.has(node.getName())) return;
            movedMemberAccesses.push(node);
        });

        const guardsToRewrite = new Set<BinaryExpression>();
        const flaggedObjectLiterals = new Set<Node>();
        const flaggedSwitches = new Set<Node>();

        for (const access of movedMemberAccesses) {
            const memberName = access.getChildAtIndex(2)?.getText() ?? access.getText();
            const line = access.getStartLineNumber();

            const comparison = getComparisonContext(access);
            if (comparison) {
                const guard = findInstanceofGuard(access, comparison.subjectText);
                if (guard) {
                    const className = guard.getRight().getText();
                    if (V1_ERROR_CLASSES.has(className)) {
                        guardsToRewrite.add(guard);
                    } else if (className !== 'SdkError') {
                        diagnostics.push(
                            error(
                                filePath,
                                line,
                                `\`${comparison.subjectText}.code === SdkErrorCode.${memberName}\` is guarded by ` +
                                    `\`instanceof ${className}\`, but v2 raises ${memberName} on SdkError. ` +
                                    `Manual fix: \`${comparison.subjectText} instanceof SdkError && ` +
                                    `${comparison.subjectText}.code === SdkErrorCode.${memberName}\`.`
                            )
                        );
                    }
                } else {
                    diagnostics.push(
                        warning(
                            filePath,
                            line,
                            `Comparison against SdkErrorCode.${memberName}: in v2 this code is raised on SdkError ` +
                                `(not McpError/ProtocolError as in v1). Verify \`${comparison.subjectText}\` is checked ` +
                                `with \`instanceof SdkError\` before this comparison.`
                        )
                    );
                }
                continue;
            }

            const caseClause = access.getFirstAncestorByKind(SyntaxKind.CaseClause);
            if (caseClause && caseClause.getExpression() === access) {
                const switchStmt = caseClause.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
                if (switchStmt && !flaggedSwitches.has(switchStmt)) {
                    flaggedSwitches.add(switchStmt);
                    const mixesProtocolCodes = switchStmt
                        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                        .some(p => Node.isIdentifier(p.getExpression()) && p.getExpression().getText() === 'ProtocolErrorCode');
                    if (mixesProtocolCodes) {
                        diagnostics.push(
                            error(
                                filePath,
                                line,
                                `switch mixes SdkErrorCode and ProtocolErrorCode cases. In v2 these enums live on ` +
                                    `different error classes (SdkError vs ProtocolError), so a single switch over ` +
                                    `\`.code\` cannot handle both. Split into an \`instanceof SdkError\` branch and an ` +
                                    `\`instanceof ProtocolError\` branch.`
                            )
                        );
                    } else {
                        diagnostics.push(
                            warning(
                                filePath,
                                line,
                                `switch case on SdkErrorCode.${memberName}: in v2 this code is raised on SdkError. ` +
                                    `Verify the switch subject is checked with \`instanceof SdkError\`.`
                            )
                        );
                    }
                }
                continue;
            }

            const computedName = access.getFirstAncestorByKind(SyntaxKind.ComputedPropertyName);
            if (computedName && computedName.getExpression() === access) {
                const objectLiteral = computedName.getFirstAncestorByKind(SyntaxKind.ObjectLiteralExpression);
                if (objectLiteral && !flaggedObjectLiterals.has(objectLiteral)) {
                    flaggedObjectLiterals.add(objectLiteral);
                    const mixesProtocolCodes = objectLiteral
                        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                        .some(p => Node.isIdentifier(p.getExpression()) && p.getExpression().getText() === 'ProtocolErrorCode');
                    diagnostics.push(
                        warning(
                            filePath,
                            line,
                            `Map keyed by SdkErrorCode.${memberName}: SdkErrorCode is a string enum in v2, so this key ` +
                                `changed from a number to a string.` +
                                (mixesProtocolCodes
                                    ? ` This literal also has ProtocolErrorCode keys (numeric) — split it into separate maps.`
                                    : ` Update any \`Record<number, ...>\` typing and numeric lookups accordingly.`)
                        )
                    );
                }
            }
        }

        for (const guard of guardsToRewrite) {
            guard.getRight().replaceWithText('SdkError');
            needsSdkErrorImport = true;
            changesCount++;
        }

        if (needsSdkErrorImport && !isImportedFromMcp(sourceFile, 'SdkError')) {
            const targetModule = resolveTargetModule(sourceFile, context);
            addOrMergeImport(sourceFile, targetModule, ['SdkError'], false, sourceFile.getImportDeclarations().length);
            changesCount++;
        }

        return { changesCount, diagnostics };
    }
};

interface ComparisonContext {
    subjectText: string;
}

/**
 * If `access` is one side of a `===`/`!==`/`==`/`!=` comparison whose other side is a
 * `<subject>.code` property access, return the subject expression text.
 */
function getComparisonContext(access: Node): ComparisonContext | undefined {
    const parent = access.getParent();
    if (!parent || !Node.isBinaryExpression(parent)) return undefined;
    const op = parent.getOperatorToken().getKind();
    if (
        op !== SyntaxKind.EqualsEqualsEqualsToken &&
        op !== SyntaxKind.ExclamationEqualsEqualsToken &&
        op !== SyntaxKind.EqualsEqualsToken &&
        op !== SyntaxKind.ExclamationEqualsToken
    ) {
        return undefined;
    }
    const other = parent.getLeft() === access ? parent.getRight() : parent.getLeft();
    if (!Node.isPropertyAccessExpression(other)) return undefined;
    if (other.getName() !== 'code') return undefined;
    return { subjectText: other.getExpression().getText() };
}

/**
 * Search the enclosing conditions for `subject instanceof <Class>`. Covers the same
 * logical-AND chain (`e instanceof X && e.code === ...`) and enclosing if/ternary
 * conditions (`if (e instanceof X) { if (e.code === ...) ... }`).
 */
function findInstanceofGuard(access: Node, subjectText: string): BinaryExpression | undefined {
    let scope: Node | undefined = access;
    while (scope) {
        if (Node.isBinaryExpression(scope) || Node.isIfStatement(scope) || Node.isConditionalExpression(scope)) {
            const searchRoot = Node.isIfStatement(scope)
                ? scope.getExpression()
                : Node.isConditionalExpression(scope)
                  ? scope.getCondition()
                  : scope;
            for (const candidate of [searchRoot, ...searchRoot.getDescendantsOfKind(SyntaxKind.BinaryExpression)]) {
                if (!Node.isBinaryExpression(candidate)) continue;
                if (candidate.getOperatorToken().getKind() !== SyntaxKind.InstanceOfKeyword) continue;
                if (candidate.getLeft().getText() !== subjectText) continue;
                return candidate;
            }
        }
        if (
            Node.isFunctionDeclaration(scope) ||
            Node.isFunctionExpression(scope) ||
            Node.isArrowFunction(scope) ||
            Node.isSourceFile(scope)
        ) {
            return undefined;
        }
        scope = scope.getParent();
    }
    return undefined;
}

function resolveTargetModule(sourceFile: SourceFile, context: TransformContext): string {
    const existing = sourceFile.getImportDeclarations().find(i => {
        const spec = i.getModuleSpecifierValue();
        return spec === '@modelcontextprotocol/client' || spec === '@modelcontextprotocol/server';
    });
    if (existing) return existing.getModuleSpecifierValue();
    if (context.projectType === 'client') return '@modelcontextprotocol/client';
    return '@modelcontextprotocol/server';
}
