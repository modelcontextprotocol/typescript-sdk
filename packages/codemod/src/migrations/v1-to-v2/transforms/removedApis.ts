import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { renameAllReferences } from '../../../utils/astUtils';
import { actionRequired, info, warning } from '../../../utils/diagnostics';
import { addOrMergeImport, hasMcpImports, isAnyMcpSpecifier } from '../../../utils/importUtils';

/**
 * v2 `finishAuth(code, iss?)` verifies the callback's `iss` when the authorization
 * server advertises `authorization_response_iss_parameter_supported` — and the v2
 * server-legacy router advertises it by default. A bare `finishAuth(code)` stays
 * type-correct (the parameter is optional) but the verification then has no input,
 * so single-argument call sites in files this run changes get a run-log note
 * pointing at the guide (not a marker: the one-argument URLSearchParams form is the
 * blessed v2 spelling and is statically indistinguishable from the code-string
 * form, so the note is advisory-only and stays quiet on already-migrated trees).
 */
function handleFinishAuthAdvisory(sourceFile: SourceFile, diagnostics: Diagnostic[]): void {
    if (!hasMcpImports(sourceFile)) return;
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'finishAuth') continue;
        if (call.getArguments().length !== 1) continue;
        diagnostics.push({
            ...warning(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                'finishAuth with one argument: if this passes the authorization code string, v2 also accepts ' +
                    'finishAuth(new URL(callbackUrl).searchParams) — preferred, since it carries the iss the callback check ' +
                    'reads when the authorization server advertises authorization_response_iss_parameter_supported ' +
                    '(the v2 server-legacy router advertises it by default). A call already passing URLSearchParams needs ' +
                    "no change. See the migration guide's authorization-server mix-up defense section."
            ),
            advisoryOnly: true
        });
    }
}

const REMOVED_ZOD_HELPERS: Record<string, string> = {
    schemaToJson:
        "Removed in v2. Use `fromJsonSchema()` from @modelcontextprotocol/server for JSON Schema, or your schema library's native conversion.",
    parseSchemaAsync: "Removed in v2. Use your schema library's validation directly (e.g., Zod's `.safeParseAsync()`).",
    getSchemaShape: "Removed in v2. These Zod-specific introspection helpers have no v2 equivalent. Use your schema library's native API.",
    getSchemaDescription:
        "Removed in v2. These Zod-specific introspection helpers have no v2 equivalent. Use your schema library's native API.",
    isOptionalSchema:
        "Removed in v2. These Zod-specific introspection helpers have no v2 equivalent. Use your schema library's native API.",
    unwrapOptionalSchema:
        "Removed in v2. These Zod-specific introspection helpers have no v2 equivalent. Use your schema library's native API."
};

export const removedApisTransform: Transform = {
    name: 'Removed API handling',
    id: 'removed-apis',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        changesCount += handleRemovedZodHelpers(sourceFile, diagnostics);
        changesCount += handleIsomorphicHeaders(sourceFile, diagnostics);
        changesCount += handleStreamableHTTPError(sourceFile, diagnostics);
        handleFinishAuthAdvisory(sourceFile, diagnostics);

        return { changesCount, diagnostics };
    }
};

function handleRemovedZodHelpers(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    interface Removal {
        importName: string;
        message: string;
        line: number;
    }

    const removals: Removal[] = [];

    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        const line = imp.getStartLineNumber();
        for (const namedImport of imp.getNamedImports()) {
            const name = namedImport.getName();
            const message = REMOVED_ZOD_HELPERS[name];
            if (message) {
                removals.push({ importName: name, message, line });
            }
        }
    }

    for (const removal of removals) {
        for (const imp of sourceFile.getImportDeclarations()) {
            if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
            for (const namedImport of imp.getNamedImports()) {
                if (namedImport.getName() === removal.importName) {
                    namedImport.remove();
                    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
                        imp.remove();
                    }
                    break;
                }
            }
        }
        diagnostics.push(warning(sourceFile.getFilePath(), removal.line, `${removal.importName}: ${removal.message}`));
    }

    return removals.length;
}

function handleIsomorphicHeaders(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changesCount = 0;
    let foundImport: ReturnType<ReturnType<SourceFile['getImportDeclarations']>[0]['getNamedImports']>[0] | undefined;
    let foundImportDecl: ReturnType<SourceFile['getImportDeclarations']>[0] | undefined;

    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'IsomorphicHeaders') {
                foundImport = namedImport;
                foundImportDecl = imp;
                break;
            }
        }
        if (foundImport) break;
    }

    if (!foundImport || !foundImportDecl) return 0;

    const localName = foundImport.getAliasNode()?.getText() ?? 'IsomorphicHeaders';
    const line = foundImportDecl.getStartLineNumber();

    renameAllReferences(sourceFile, localName, 'Headers');
    changesCount++;

    foundImport.remove();
    if (foundImportDecl.getNamedImports().length === 0 && !foundImportDecl.getDefaultImport() && !foundImportDecl.getNamespaceImport()) {
        foundImportDecl.remove();
    }
    changesCount++;

    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            line,
            'IsomorphicHeaders replaced with standard Web Headers API. Note: Headers uses .get()/.set() methods, not bracket access.'
        )
    );

    return changesCount;
}

function handleStreamableHTTPError(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changesCount = 0;
    let foundImport: ReturnType<ReturnType<SourceFile['getImportDeclarations']>[0]['getNamedImports']>[0] | undefined;
    let foundImportDecl: ReturnType<SourceFile['getImportDeclarations']>[0] | undefined;

    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'StreamableHTTPError') {
                foundImport = namedImport;
                foundImportDecl = imp;
                break;
            }
        }
        if (foundImport) break;
    }

    if (!foundImport || !foundImportDecl) return 0;

    const localName = foundImport.getAliasNode()?.getText() ?? 'StreamableHTTPError';
    const line = foundImportDecl.getStartLineNumber();
    const moduleSpec = foundImportDecl.getModuleSpecifierValue();

    let hasConstructorCalls = false;
    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;
        hasConstructorCalls = true;
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                node,
                'new StreamableHTTPError(statusCode, statusText, body?) → new SdkHttpError(code, message, data). ' +
                    'Constructor arguments differ — manual review required. Map the HTTP status to a SdkErrorCode enum value ' +
                    'and pass the HTTP status via the data argument, e.g. { status, statusText }.'
            )
        );
    }

    renameAllReferences(sourceFile, localName, 'SdkHttpError');
    changesCount++;

    changesCount += rewriteGuardedStatusReads(sourceFile, diagnostics);

    foundImport.remove();
    if (foundImportDecl.getNamedImports().length === 0 && !foundImportDecl.getDefaultImport() && !foundImportDecl.getNamespaceImport()) {
        foundImportDecl.remove();
    }

    const targetModule = resolveTargetModule(sourceFile, moduleSpec);
    const insertIndex = sourceFile.getImportDeclarations().length;
    const importsToAdd = hasConstructorCalls ? ['SdkHttpError', 'SdkErrorCode'] : ['SdkHttpError'];
    addOrMergeImport(sourceFile, targetModule, importsToAdd, false, insertIndex);
    changesCount++;

    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            line,
            'StreamableHTTPError replaced with SdkHttpError (a subclass of SdkError). ' +
                'HTTP status and status text are now available via error.status and error.statusText. ' +
                'Note: unexpected-content-type responses (HTTP 200 with the wrong content type) are thrown as the ' +
                'base SdkError, not SdkHttpError, so a catch-all check should use `instanceof SdkError`.'
        )
    );

    return changesCount;
}

function resolveTargetModule(sourceFile: SourceFile, originalModule: string): string {
    const imp = sourceFile.getImportDeclarations().find(i => {
        const spec = i.getModuleSpecifierValue();
        return spec === '@modelcontextprotocol/client' || spec === '@modelcontextprotocol/server';
    });
    if (imp) return imp.getModuleSpecifierValue();

    if (originalModule.includes('/client')) return '@modelcontextprotocol/client';
    return '@modelcontextprotocol/server';
}

/**
 * Climb only through positive conjunctions (`&&`) and parentheses: under `||` or `!`
 * the other operand evaluates exactly when the instanceof check FAILED, so it is not
 * a guarded scope.
 */
function conjunctionRootOf(node: Node): Node {
    let top: Node = node;
    let parent = top.getParent();
    while (parent !== undefined) {
        if (Node.isParenthesizedExpression(parent)) {
            top = parent;
        } else if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken) {
            top = parent;
        } else {
            break;
        }
        parent = top.getParent();
    }
    return top;
}

/** True when `name` is rebound by a function parameter between `node` and `scopeRoot`. */
function isShadowedWithin(node: Node, scopeRoot: Node, name: string): boolean {
    let current = node.getParent();
    while (current !== undefined && current !== scopeRoot) {
        if (
            (Node.isArrowFunction(current) ||
                Node.isFunctionExpression(current) ||
                Node.isFunctionDeclaration(current) ||
                Node.isMethodDeclaration(current)) &&
            current.getParameters().some(param => param.getName() === name)
        ) {
            return true;
        }
        current = current.getParent();
    }
    return false;
}

/** True when the scope contains any assignment whose left side is `subject`. */
function subjectReassignedWithin(scope: Node, subject: string): boolean {
    return scope.getDescendantsOfKind(SyntaxKind.BinaryExpression).some(bin => {
        const op = bin.getOperatorToken().getKind();
        return (
            (op === SyntaxKind.EqualsToken || op === SyntaxKind.QuestionQuestionEqualsToken || op === SyntaxKind.BarBarEqualsToken) &&
            bin.getLeft().getText() === subject
        );
    });
}

/**
 * v2 carries the HTTP status on `.status`; `.code` is an `SdkErrorCode` string. A
 * `.code` read on a value the surrounding check proves is an `SdkHttpError` —
 * positive-conjunction siblings of the check, or reads inside the positively guarded
 * if-block — rewrites mechanically. Unprovable reads keep the existing file-level
 * warning.
 */
function rewriteGuardedStatusReads(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    let changes = 0;
    for (const guard of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (guard.wasForgotten()) continue;
        if (guard.getOperatorToken().getKind() !== SyntaxKind.InstanceOfKeyword) continue;
        const right = guard.getRight();
        if (!Node.isIdentifier(right) || right.getText() !== 'SdkHttpError') continue;
        const subject = guard.getLeft().getText();

        const conjunctionRoot = conjunctionRootOf(guard);
        const scopes: Node[] = [conjunctionRoot];
        // The then-block is guarded only when the check reaches the if condition
        // through positive conjunctions alone (no `!`, no `||` on the path).
        const ifStmt = guard.getFirstAncestorByKind(SyntaxKind.IfStatement);
        if (ifStmt !== undefined && conjunctionRoot === ifStmt.getExpression()) {
            const thenBlock = ifStmt.getThenStatement();
            if (!subjectReassignedWithin(thenBlock, subject)) scopes.push(thenBlock);
        }

        let rewrote = false;
        for (const scope of scopes) {
            const reads = scope
                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                .filter(
                    pa =>
                        !pa.wasForgotten() &&
                        pa.getName() === 'code' &&
                        pa.getExpression().getText() === subject &&
                        !isShadowedWithin(pa, scope, subject)
                );
            for (const pa of reads.toReversed()) {
                pa.getNameNode().replaceWithText('status');
                changes++;
                rewrote = true;
            }
        }
        if (rewrote) {
            diagnostics.push(
                info(
                    sourceFile.getFilePath(),
                    guard.getStartLineNumber(),
                    `Rewrote ${subject}.code to ${subject}.status under the instanceof SdkHttpError check — v2 carries ` +
                        `the HTTP status on .status (.code is an SdkErrorCode string).`
                )
            );
        }
    }
    return changes;
}
