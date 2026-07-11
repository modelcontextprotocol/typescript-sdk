import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { findFirstIdentifierOutsideImports, renameAllReferences } from '../../../utils/astUtils';
import { actionRequired, info, warning } from '../../../utils/diagnostics';
import { addOrMergeImport, isAnyMcpSpecifier, isV2Specifier, removeUnusedImport } from '../../../utils/importUtils';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer';
import { ERROR_CODE_SDK_MEMBERS, SIMPLE_RENAMES } from '../mappings/symbolMap';

const SERVER_GENERIC_ARGS = new Set(['ServerRequest', 'ServerNotification']);
const CLIENT_GENERIC_ARGS = new Set(['ClientRequest', 'ClientNotification']);

export const symbolRenamesTransform: Transform = {
    name: 'Symbol renames',
    id: 'symbols',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        const imports = sourceFile.getImportDeclarations();

        for (const imp of imports) {
            if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
            for (const namedImport of imp.getNamedImports()) {
                const name = namedImport.getName();
                const newName = SIMPLE_RENAMES[name];
                if (newName) {
                    namedImport.setName(newName);
                    const alias = namedImport.getAliasNode();
                    if (!alias) {
                        renameAllReferences(sourceFile, name, newName);
                    }
                    changesCount++;
                }
            }
        }

        changesCount += renameDynamicImportBindings(sourceFile);
        changesCount += handleErrorCodeSplit(sourceFile, diagnostics);
        changesCount += handleRequestHandlerExtra(sourceFile, context, diagnostics);
        changesCount += handleSchemaInput(sourceFile, context, diagnostics);

        return { changesCount, diagnostics };
    }
};

function handleErrorCodeSplit(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let errorCodeImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;

    for (const imp of imports) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'ErrorCode') {
                errorCodeImport = namedImport;
                break;
            }
        }
        if (errorCodeImport) break;
    }

    if (!errorCodeImport) return 0;

    const errorCodeLocalName = errorCodeImport.getAliasNode()?.getText() ?? 'ErrorCode';

    let needsProtocolErrorCode = false;
    let needsSdkErrorCode = false;
    let needsSdkError = false;

    // First pass: rewrite the enum sides and remember which boolean expressions hold
    // SDK-member comparisons, protocol-member comparisons, or both. The instanceof
    // pairing decision needs the WHOLE expression's membership, so it runs after.
    interface BooleanExprInfo {
        hasSdkMember: boolean;
        hasProtocolMember: boolean;
    }
    const booleanExprs = new Map<Node, BooleanExprInfo>();
    const ctorExprs = new Map<import('ts-morph').NewExpression, BooleanExprInfo>();
    const matcherSubjects = new Map<Node, Map<string, BooleanExprInfo>>();

    sourceFile.forEachDescendant(node => {
        if (!Node.isPropertyAccessExpression(node)) return;
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== errorCodeLocalName) return;

        const member = node.getName();
        const isSdkMember = ERROR_CODE_SDK_MEMBERS.has(member);
        node.getExpression().replaceWithText(isSdkMember ? 'SdkErrorCode' : 'ProtocolErrorCode');
        if (isSdkMember) needsSdkErrorCode = true;
        else needsProtocolErrorCode = true;
        changesCount++;

        if (isInComparisonContext(node)) {
            const root = booleanExpressionRoot(node);
            const entry = booleanExprs.get(root) ?? { hasSdkMember: false, hasProtocolMember: false };
            if (isSdkMember) entry.hasSdkMember = true;
            else entry.hasProtocolMember = true;
            booleanExprs.set(root, entry);
        }

        // Constructor pairing: `new ProtocolError(ErrorCode.RequestTimeout, …)` — the
        // SDK-routed codes ride on SdkError, so the class must move with the member.
        // Only the FIRST argument (the code) participates, and per-constructor
        // membership is tracked so a ternary mixing both enums gets a marker rather
        // than a wrong class.
        {
            const newExpr = node.getFirstAncestorByKind(SyntaxKind.NewExpression);
            const classExpr = newExpr?.getExpression();
            const firstArg = newExpr?.getArguments()[0];
            if (
                newExpr !== undefined &&
                classExpr !== undefined &&
                firstArg !== undefined &&
                Node.isIdentifier(classExpr) &&
                (classExpr.getText() === 'ProtocolError' || classExpr.getText() === 'McpError') &&
                (node === firstArg || node.getAncestors().includes(firstArg))
            ) {
                const entry = ctorExprs.get(newExpr) ?? { hasSdkMember: false, hasProtocolMember: false };
                if (isSdkMember) entry.hasSdkMember = true;
                else entry.hasProtocolMember = true;
                ctorExprs.set(newExpr, entry);
            }
        }

        // Matcher pairing: `expect(err.code).toBe(ErrorCode.X)` assertions correlate —
        // by asserted subject within the enclosing block — with
        // `expect(err).toBeInstanceOf(…)` class assertions handled below.
        const subject = matcherSubjectOf(node);
        if (subject !== undefined) {
            const block: Node = node.getFirstAncestorByKind(SyntaxKind.Block) ?? sourceFile;
            let bySubject = matcherSubjects.get(block);
            if (!bySubject) {
                bySubject = new Map();
                matcherSubjects.set(block, bySubject);
            }
            const entry = bySubject.get(subject) ?? { hasSdkMember: false, hasProtocolMember: false };
            if (isSdkMember) entry.hasSdkMember = true;
            else entry.hasProtocolMember = true;
            bySubject.set(subject, entry);
        }
    });

    for (const [newExpr, entry] of ctorExprs) {
        if (!entry.hasSdkMember) continue;
        if (entry.hasProtocolMember) {
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    newExpr,
                    `This constructor's code argument mixes SdkErrorCode and ProtocolErrorCode members, but v2 raises ` +
                        `them on different error classes (SdkError and ProtocolError). Split the construction per class.`
                )
            );
        } else {
            newExpr.getExpression().replaceWithText('SdkError');
            needsSdkError = true;
        }
    }

    // `toBeInstanceOf(ProtocolError)` assertions whose subject is also asserted to
    // carry an SDK-routed code in the same block follow the same rule as instanceof
    // guards: all-SDK rewrites the class, mixed gets a marker.
    {
        let unpairedMatcherSites = 0;
        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const callee = call.getExpression();
            if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'toBeInstanceOf') continue;
            const classArg = call.getArguments()[0];
            if (classArg === undefined || !Node.isIdentifier(classArg)) continue;
            const className = classArg.getText();
            if (className !== 'ProtocolError' && className !== 'McpError') continue;
            const subject = instanceofSubjectOf(callee.getExpression());
            const block: Node = call.getFirstAncestorByKind(SyntaxKind.Block) ?? sourceFile;
            const entry = subject === undefined ? undefined : matcherSubjects.get(block)?.get(subject);
            if (!entry || !entry.hasSdkMember) {
                if (needsSdkErrorCode) unpairedMatcherSites++;
                continue;
            }
            if (entry.hasProtocolMember) {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        `This subject is asserted with both SdkErrorCode and ProtocolErrorCode members, but v2 raises them ` +
                            `on different error classes — one toBeInstanceOf cannot cover both. Split the assertions per class.`
                    )
                );
            } else {
                classArg.replaceWithText('SdkError');
                needsSdkError = true;
                if (subject !== undefined) {
                    const fnAncestor = call.getFirstAncestor(
                        a =>
                            Node.isArrowFunction(a) ||
                            Node.isFunctionExpression(a) ||
                            Node.isFunctionDeclaration(a) ||
                            Node.isMethodDeclaration(a)
                    );
                    const fnBody =
                        fnAncestor !== undefined &&
                        (Node.isArrowFunction(fnAncestor) ||
                            Node.isFunctionExpression(fnAncestor) ||
                            Node.isFunctionDeclaration(fnAncestor) ||
                            Node.isMethodDeclaration(fnAncestor))
                            ? fnAncestor.getBody()
                            : undefined;
                    repointSubjectCasts(fnBody ?? block, subject);
                }
            }
        }
        // Codes the codemod routed to SdkErrorCode pair with SdkError; class matchers it
        // could not correlate (cast/aliased subjects, toMatchObject shapes) may still
        // name the wrong class — surface a run-log note, not a marker.
        if (unpairedMatcherSites > 0 && needsSdkErrorCode) {
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    1,
                    `This file routes ErrorCode members to SdkErrorCode and also asserts error classes with ` +
                        `toBeInstanceOf — review those assertions: SDK-routed codes are raised on SdkError, not ProtocolError.`
                )
            );
        }
    }

    // Second pass: v2 raises the SDK codes on SdkError, not ProtocolError, so a
    // guard of `instanceof ProtocolError` paired with an SDK-code comparison never
    // matches. When the expression compares ONLY SDK codes, the guard rewrites
    // mechanically; when it mixes SDK and protocol codes, one guard cannot cover
    // both classes — mark it. Expressions with no instanceof guard are left alone
    // (the enclosing guard, if any, may be elsewhere and already correct).
    for (const [root, entry] of booleanExprs) {
        if (!entry.hasSdkMember) continue;
        for (const guard of instanceofGuards(root)) {
            if (entry.hasProtocolMember) {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        guard,
                        `This check compares both SdkErrorCode and ProtocolErrorCode members, but v2 raises them on ` +
                            `different error classes (SdkError and ProtocolError) — one instanceof guard cannot cover both. ` +
                            `Split the check per error class.`
                    )
                );
            } else if (guardPinnedToSdkCode(guard)) {
                guard.getRight().replaceWithText('SdkError');
                needsSdkError = true;
            } else {
                // `e instanceof X || e.code === SdkErrorCode.Y`, `e instanceof X &&
                // e.code !== …`, a comparison on another subject: v1's class carried
                // BOTH code families, so no single v2 class reproduces this check.
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        guard,
                        `In v1 this class carried both the protocol codes and the SDK-local codes; in v2 they split into ` +
                            `ProtocolError and SdkError. The codes compared here route to SdkErrorCode, but this check's shape ` +
                            `does not pin the guarded value to one class — match SdkError for SDK-raised codes, ProtocolError ` +
                            `for wire errors, or both.`
                    )
                );
            }
        }
    }

    if (changesCount === 0) {
        const decl = errorCodeImport.getImportDeclaration();
        // Only a v2 specifier warrants the drop: none of the v2 packages export
        // `ErrorCode`, so leaving the named import behind fails at module link time.
        // A still-v1 specifier (isolated `--transforms symbols` run) is valid as-is —
        // the imports transform handles it when it runs.
        if (!isV2Specifier(decl.getModuleSpecifierValue())) return 0;
        // Drop it and mark the first remaining use (re-export-only files are handled
        // by the export rewrite's own warning).
        const usage = findFirstIdentifierOutsideImports(sourceFile, errorCodeLocalName);
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                usage ?? decl,
                `${errorCodeLocalName} is not exported by the v2 packages — it split into ProtocolErrorCode (protocol codes) ` +
                    `and SdkErrorCode (local SDK codes). No direct member access could be rewritten here; replace the remaining ` +
                    `uses with the appropriate enum.`
            )
        );
        errorCodeImport.remove();
        if (decl.getNamedImports().length === 0 && !decl.getDefaultImport() && !decl.getNamespaceImport()) {
            decl.remove();
        }
        return 1;
    }

    {
        const errorCodeImportDecl = errorCodeImport.getImportDeclaration();
        // Capture target module before removing the import, so we don't lose the original
        // module specifier when ErrorCode was the only named import in the declaration.
        const origModule = errorCodeImportDecl.getModuleSpecifierValue();
        const imp =
            sourceFile.getImportDeclarations().find(i => {
                const spec = i.getModuleSpecifierValue();
                return (spec === '@modelcontextprotocol/client' || spec === '@modelcontextprotocol/server') && !i.isTypeOnly();
            }) ??
            sourceFile.getImportDeclarations().find(i => {
                const spec = i.getModuleSpecifierValue();
                return spec === '@modelcontextprotocol/client' || spec === '@modelcontextprotocol/server';
            });
        const targetModule = imp?.getModuleSpecifierValue() ?? origModule ?? '@modelcontextprotocol/server';

        errorCodeImport.remove();
        if (
            errorCodeImportDecl.getNamedImports().length === 0 &&
            !errorCodeImportDecl.getDefaultImport() &&
            !errorCodeImportDecl.getNamespaceImport()
        ) {
            errorCodeImportDecl.remove();
        }

        const newImports: string[] = [];
        if (needsProtocolErrorCode) newImports.push('ProtocolErrorCode');
        if (needsSdkErrorCode) newImports.push('SdkErrorCode');
        if (needsSdkError) newImports.push('SdkError');

        if (newImports.length > 0) {
            const existingImp = sourceFile
                .getImportDeclarations()
                .find(i => i.getModuleSpecifierValue() === targetModule && !i.isTypeOnly() && !i.getNamespaceImport());
            if (existingImp) {
                const existingNames = new Set(existingImp.getNamedImports().map(n => n.getName()));
                const toAdd = newImports.filter(n => !existingNames.has(n));
                if (toAdd.length > 0) {
                    existingImp.addNamedImports(toAdd);
                }
            } else {
                sourceFile.addImportDeclaration({
                    moduleSpecifier: targetModule,
                    namedImports: newImports
                });
            }
        }

        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                1,
                'ErrorCode split into ProtocolErrorCode and SdkErrorCode. Verify the migration is correct.'
            )
        );
    }

    if (needsSdkError) {
        // Class rewrites can leave the original error-class import referenced nowhere.
        removeUnusedImport(sourceFile, 'ProtocolError', true);
        removeUnusedImport(sourceFile, 'McpError', true);
    }

    return changesCount;
}

const MATCHER_EQUALITY_NAMES = new Set(['toBe', 'toEqual', 'toStrictEqual']);

/** Strip parentheses and `as`/`satisfies` casts. */
function unwrapCasts(node: Node): Node {
    let current = node;
    while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current) || Node.isSatisfiesExpression(current)) {
        current = current.getExpression();
    }
    return current;
}

/**
 * For `expect(x.code).toBe(<member>)`-style assertions where `memberNode` is the
 * matcher argument, the asserted subject (`x`) — undefined when the member is not in
 * that shape. Only a `.code` / `['code']` property read pairs (that is the premise of
 * the class/code correlation); casts around the base are stripped so
 * `expect((err as any).code)` pairs with `expect(err)`.
 */
function matcherSubjectOf(memberNode: Node): string | undefined {
    const parent = memberNode.getParent();
    if (parent === undefined || !Node.isCallExpression(parent)) return undefined;
    if (!parent.getArguments().includes(memberNode)) return undefined;
    const callee = parent.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !MATCHER_EQUALITY_NAMES.has(callee.getName())) return undefined;
    const expectArg = expectArgumentOf(callee.getExpression());
    if (expectArg === undefined) return undefined;
    const arg = unwrapCasts(expectArg);
    if (Node.isPropertyAccessExpression(arg) && arg.getName() === 'code') {
        return unwrapCasts(arg.getExpression()).getText();
    }
    if (Node.isElementAccessExpression(arg)) {
        const key = arg.getArgumentExpression();
        if (key !== undefined && Node.isStringLiteral(key) && key.getLiteralValue() === 'code') {
            return unwrapCasts(arg.getExpression()).getText();
        }
    }
    return undefined;
}

/**
 * The subject a `toBeInstanceOf` assertion is about: the full (cast-stripped) text of
 * the expect argument — `expect(err.cause)` asserts `err.cause`, not `err`.
 */
function instanceofSubjectOf(expr: Node): string | undefined {
    const arg = expectArgumentOf(expr);
    if (arg === undefined) return undefined;
    return unwrapCasts(arg).getText();
}

/** Walk an expect-chain receiver (`expect(x)`, `expect(x).rejects`, …) to the expect call's first argument. */
function expectArgumentOf(expr: Node): Node | undefined {
    let current: Node | undefined = expr;
    while (current !== undefined) {
        if (Node.isCallExpression(current)) {
            const callee = current.getExpression();
            if (Node.isIdentifier(callee) && callee.getText() === 'expect') {
                return current.getArguments()[0];
            }
            current = callee;
            continue;
        }
        if (Node.isPropertyAccessExpression(current)) {
            current = current.getExpression();
            continue;
        }
        return undefined;
    }
    return undefined;
}

const EQUALITY_OPERATORS = new Set([
    SyntaxKind.EqualsEqualsToken,
    SyntaxKind.EqualsEqualsEqualsToken,
    SyntaxKind.ExclamationEqualsToken,
    SyntaxKind.ExclamationEqualsEqualsToken
]);

/** True when the member access is one side of an equality comparison or a switch case expression. */
function isInComparisonContext(node: Node): boolean {
    const parent = node.getParent();
    if (parent !== undefined && Node.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.getOperatorToken().getKind())) {
        return true;
    }
    return parent !== undefined && Node.isCaseClause(parent);
}

const LOGICAL_OPERATORS = new Set([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken]);

/**
 * The outermost expression reachable from `node` through logical operators (&&/||),
 * parentheses, and `!` only — assignments, comma sequences, and arithmetic stop the
 * climb so a guard stored or reused elsewhere is never claimed.
 */
function booleanExpressionRoot(node: Node): Node {
    let top: Node = node;
    let parent = top.getParent();
    while (parent !== undefined) {
        if (Node.isParenthesizedExpression(parent) || Node.isPrefixUnaryExpression(parent)) {
            top = parent;
        } else if (Node.isBinaryExpression(parent)) {
            const op = parent.getOperatorToken().getKind();
            if (!LOGICAL_OPERATORS.has(op) && !EQUALITY_OPERATORS.has(op)) break;
            top = parent;
        } else {
            break;
        }
        parent = top.getParent();
    }
    return top;
}

/**
 * Whether the class an `instanceof` guard names is pinned by a conjoined SDK-routed
 * code comparison ON THE SAME SUBJECT: `e instanceof X && e.code ===
 * SdkErrorCode.RequestTimeout`, including a negated guard (`!(e instanceof X) && …`
 * excludes exactly the SDK-raised codes, which ride on SdkError in v2) and a
 * disjunction of same-subject SDK codes (`e instanceof X && (e.code === A || e.code
 * === B)`). A code reached only through `||` with the guard, a negated comparison
 * (`!==`), another subject's code, or a nested function proves nothing about this
 * guard's class.
 */
function guardPinnedToSdkCode(guard: import('ts-morph').BinaryExpression): boolean {
    const subject = unwrapCasts(guard.getLeft()).getText();

    // Conjunction scope of the guard: parentheses, negation of the guard itself, `&&`.
    let top: Node = guard;
    let parent = top.getParent();
    while (parent !== undefined) {
        const isAnd = Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken;
        if (!Node.isParenthesizedExpression(parent) && !Node.isPrefixUnaryExpression(parent) && !isAnd) break;
        top = parent;
        parent = top.getParent();
    }
    return pinsSubjectToSdkCode(top, subject, guard);
}

/**
 * Boolean-shape evaluation of "every way this expression is satisfied constrains
 * `subject` to an SDK-routed code": an `&&` pins if either conjunct pins, an `||`
 * pins only if every branch pins, a leaf pins only as a positive same-subject
 * `SdkErrorCode` equality. The guard itself and anything else (calls, negations,
 * other subjects) never pin.
 */
function pinsSubjectToSdkCode(node: Node, subject: string, guard: Node): boolean {
    let expr: Node = node;
    while (Node.isParenthesizedExpression(expr)) expr = expr.getExpression();
    if (expr === guard) return false;
    if (!Node.isBinaryExpression(expr)) return false;
    const op = expr.getOperatorToken().getKind();
    if (op === SyntaxKind.AmpersandAmpersandToken) {
        return pinsSubjectToSdkCode(expr.getLeft(), subject, guard) || pinsSubjectToSdkCode(expr.getRight(), subject, guard);
    }
    if (op === SyntaxKind.BarBarToken) {
        return pinsSubjectToSdkCode(expr.getLeft(), subject, guard) && pinsSubjectToSdkCode(expr.getRight(), subject, guard);
    }
    if (op !== SyntaxKind.EqualsEqualsEqualsToken && op !== SyntaxKind.EqualsEqualsToken) return false;
    const sides = [expr.getLeft(), expr.getRight()];
    const memberSide = sides.find(side => Node.isPropertyAccessExpression(side) && side.getExpression().getText() === 'SdkErrorCode');
    if (memberSide === undefined) return false;
    const valueSide = unwrapCasts(sides.find(side => side !== memberSide)!);
    if (!Node.isPropertyAccessExpression(valueSide) && !Node.isElementAccessExpression(valueSide)) return false;
    return unwrapCasts(valueSide.getExpression()).getText() === subject;
}

/** `instanceof ProtocolError`/`instanceof McpError` checks within the expression. */
function instanceofGuards(root: Node): import('ts-morph').BinaryExpression[] {
    const guards: import('ts-morph').BinaryExpression[] = [];
    const visit = (candidate: Node): void => {
        if (Node.isBinaryExpression(candidate) && candidate.getOperatorToken().getKind() === SyntaxKind.InstanceOfKeyword) {
            const right = candidate.getRight();
            if (Node.isIdentifier(right) && (right.getText() === 'ProtocolError' || right.getText() === 'McpError')) {
                guards.push(candidate);
            }
        }
    };
    visit(root);
    root.forEachDescendant(visit);
    return guards;
}

function handleRequestHandlerExtra(sourceFile: SourceFile, context: TransformContext, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let extraImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;
    let extraImportDecl: (typeof imports)[0] | undefined;

    for (const imp of imports) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'RequestHandlerExtra') {
                extraImport = namedImport;
                extraImportDecl = imp;
                break;
            }
        }
        if (extraImport) break;
    }

    if (!extraImport) return 0;

    const extraLocalName = extraImport.getAliasNode()?.getText() ?? 'RequestHandlerExtra';

    const isClientFile = sourceFile.getImportDeclarations().some(i => {
        const spec = i.getModuleSpecifierValue();
        return spec.includes('/client/') || spec === '@modelcontextprotocol/client';
    });
    const isServerFile = sourceFile.getImportDeclarations().some(i => {
        const spec = i.getModuleSpecifierValue();
        return spec.includes('/server/') || spec === '@modelcontextprotocol/server';
    });

    let defaultTarget: 'ServerContext' | 'ClientContext' = 'ServerContext';
    if (isClientFile && !isServerFile) {
        defaultTarget = 'ClientContext';
    } else if (context.projectType === 'client') {
        defaultTarget = 'ClientContext';
    }

    let needsServerContext = false;
    let needsClientContext = false;
    const strippedArgNames = new Set<string>();

    sourceFile.forEachDescendant(node => {
        if (!Node.isTypeReference(node)) return;
        const typeName = node.getTypeName();
        if (!Node.isIdentifier(typeName) || typeName.getText() !== extraLocalName) return;

        let target = defaultTarget;
        const typeArgs = node.getTypeArguments();
        if (typeArgs.length > 0) {
            const firstArgText = typeArgs[0]!.getText();
            if (SERVER_GENERIC_ARGS.has(firstArgText)) {
                target = 'ServerContext';
            } else if (CLIENT_GENERIC_ARGS.has(firstArgText)) {
                target = 'ClientContext';
            }
        }

        if (target === 'ServerContext') needsServerContext = true;
        if (target === 'ClientContext') needsClientContext = true;

        if (typeArgs.length > 0) {
            for (const arg of typeArgs) {
                const argText = arg.getText();
                if (SERVER_GENERIC_ARGS.has(argText) || CLIENT_GENERIC_ARGS.has(argText)) {
                    strippedArgNames.add(argText);
                }
            }
            node.replaceWithText(target);
        } else {
            typeName.replaceWithText(target);
        }
        changesCount++;
    });

    if (changesCount > 0) {
        const extraImportLine = extraImportDecl!.getStartLineNumber();
        extraImport.remove();
        if (
            extraImportDecl!.getNamedImports().length === 0 &&
            !extraImportDecl!.getDefaultImport() &&
            !extraImportDecl!.getNamespaceImport()
        ) {
            extraImportDecl!.remove();
        }

        const newImports: Array<{ name: string; target: string }> = [];
        if (needsServerContext) newImports.push({ name: 'ServerContext', target: '@modelcontextprotocol/server' });
        if (needsClientContext) newImports.push({ name: 'ClientContext', target: '@modelcontextprotocol/client' });

        for (const { name, target } of newImports) {
            const existingImp = sourceFile
                .getImportDeclarations()
                .find(i => i.getModuleSpecifierValue() === target && i.isTypeOnly() && !i.getNamespaceImport());
            if (existingImp) {
                const existingNames = new Set(existingImp.getNamedImports().map(n => n.getName()));
                if (!existingNames.has(name)) {
                    existingImp.addNamedImports([name]);
                }
            } else {
                const valueImp = sourceFile
                    .getImportDeclarations()
                    .find(i => i.getModuleSpecifierValue() === target && !i.isTypeOnly() && !i.getNamespaceImport());
                if (valueImp) {
                    const existingNames = new Set(valueImp.getNamedImports().map(n => n.getName()));
                    if (!existingNames.has(name)) {
                        valueImp.addNamedImports([name]);
                    }
                } else {
                    sourceFile.addImportDeclaration({
                        isTypeOnly: true,
                        moduleSpecifier: target,
                        namedImports: [name]
                    });
                }
            }
        }

        for (const argName of strippedArgNames) {
            removeUnusedImport(sourceFile, argName, true);
        }

        changesCount++;

        const targets = newImports.map(i => i.name).join(' and ');
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                extraImportLine,
                `RequestHandlerExtra renamed to ${targets}. Generic type arguments removed. Verify the migration is correct.`
            )
        );
    }

    return changesCount;
}

function handleSchemaInput(sourceFile: SourceFile, context: TransformContext, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let schemaInputImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;
    let schemaInputImportDecl: (typeof imports)[0] | undefined;

    for (const imp of imports) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'SchemaInput') {
                schemaInputImport = namedImport;
                schemaInputImportDecl = imp;
                break;
            }
        }
        if (schemaInputImport) break;
    }

    if (!schemaInputImport || !schemaInputImportDecl) return 0;

    const schemaInputLocalName = schemaInputImport.getAliasNode()?.getText() ?? 'SchemaInput';

    sourceFile.forEachDescendant(node => {
        if (!Node.isTypeReference(node)) return;
        const typeName = node.getTypeName();
        if (!Node.isIdentifier(typeName) || typeName.getText() !== schemaInputLocalName) return;

        const typeArgs = node.getTypeArguments();
        if (typeArgs.length > 0) {
            const argText = typeArgs[0]!.getText();
            node.replaceWithText(`StandardSchemaWithJSON.InferInput<${argText}>`);
        } else {
            node.replaceWithText('StandardSchemaWithJSON.InferInput<unknown>');
        }
        changesCount++;
    });

    if (changesCount > 0) {
        schemaInputImport.remove();
        if (
            schemaInputImportDecl.getNamedImports().length === 0 &&
            !schemaInputImportDecl.getDefaultImport() &&
            !schemaInputImportDecl.getNamespaceImport()
        ) {
            schemaInputImportDecl.remove();
        }

        const isClientFile = sourceFile.getImportDeclarations().some(i => {
            const spec = i.getModuleSpecifierValue();
            return spec.includes('/client/') || spec === '@modelcontextprotocol/client';
        });
        const isServerFile = sourceFile.getImportDeclarations().some(i => {
            const spec = i.getModuleSpecifierValue();
            return spec.includes('/server/') || spec === '@modelcontextprotocol/server';
        });
        const targetModule = resolveTypesPackage(context, isClientFile, isServerFile);

        const insertIndex = sourceFile.getImportDeclarations().length;
        addOrMergeImport(sourceFile, targetModule, ['StandardSchemaWithJSON'], true, insertIndex);
        changesCount++;

        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                1,
                'SchemaInput<T> replaced with StandardSchemaWithJSON.InferInput<T>. Verify the migration is correct.'
            )
        );
    }

    return changesCount;
}

/**
 * When the pairing moves a subject's asserted class to SdkError, a
 * `const err = (await p) as ProtocolError` binding for the same subject becomes a
 * type lie (.code typed as a number while the runtime value is an SdkErrorCode
 * string) — re-point the cast with the assertion.
 */
function repointSubjectCasts(scope: Node, subject: string): void {
    const repointIn = (expr: Node): void => {
        const casts = Node.isAsExpression(expr) ? [expr] : expr.getDescendantsOfKind(SyntaxKind.AsExpression);
        for (const cast of casts) {
            if (cast.wasForgotten()) continue;
            const typeNode = cast.getTypeNode();
            const typeText = typeNode?.getText();
            if (typeNode !== undefined && (typeText === 'ProtocolError' || typeText === 'McpError')) {
                typeNode.replaceWithText('SdkError');
            }
        }
    };
    for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (decl.wasForgotten() || decl.getName() !== subject) continue;
        const initializer = decl.getInitializer();
        if (initializer !== undefined) repointIn(initializer);
    }
    // `err = e as McpError` inside a catch block is the dominant test shape — the
    // cast lives in an assignment, not a declaration.
    for (const bin of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (bin.wasForgotten()) continue;
        if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        if (bin.getLeft().getText() !== subject) continue;
        repointIn(bin.getRight());
    }
}

/**
 * `const { McpError } = await import('@modelcontextprotocol/…')` — the static-import
 * rename pass never sees these bindings. Shorthand elements rename binding and
 * references; aliased elements (`{ McpError: ME }`) re-point only the property name.
 */
function renameDynamicImportBindings(sourceFile: SourceFile): number {
    let changes = 0;
    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (decl.wasForgotten()) continue;
        const nameNode = decl.getNameNode();
        if (!Node.isObjectBindingPattern(nameNode)) continue;
        let initializer = decl.getInitializer();
        if (initializer !== undefined && Node.isAwaitExpression(initializer)) initializer = initializer.getExpression();
        if (initializer === undefined || !Node.isCallExpression(initializer)) continue;
        if (initializer.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
        const spec = initializer.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
        if (spec === undefined || !isAnyMcpSpecifier(spec)) continue;
        for (const element of nameNode.getElements()) {
            const propertyNode = element.getPropertyNameNode();
            const importedName = propertyNode?.getText() ?? element.getName();
            const newName = SIMPLE_RENAMES[importedName];
            if (newName === undefined) continue;
            if (propertyNode === undefined) {
                // Text-based like every other rename here — the language-service rename
                // resolves to the installed v1 typings and can split the shorthand into
                // a dead-property alias or touch node_modules.
                renameAllReferences(sourceFile, importedName, newName);
            } else {
                propertyNode.replaceWithText(newName);
            }
            changes++;
        }
    }
    return changes;
}
