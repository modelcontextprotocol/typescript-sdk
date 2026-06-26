import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { renameAllReferences } from '../../../utils/astUtils';
import { actionRequired, warning } from '../../../utils/diagnostics';
import { addOrMergeImport, isAnyMcpSpecifier } from '../../../utils/importUtils';

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

    // v1's `StreamableHTTPError.code` carried the HTTP status (number); v2's `SdkHttpError.code` is the
    // `SdkErrorCode` enum string and the status moved to `.status`. The class rename below keeps
    // `error.code === 404` compiling (TS2367 if `error` is narrowed to `SdkHttpError`, otherwise no
    // error) but always-false at runtime — the silent-misclassification class. Mark every `.code`
    // access on an identifier that is `instanceof`-checked against this class so the user is steered to
    // `.status` at the exact site, not just the file-level summary warning.
    const instanceofSubjects = new Set<string>();
    for (const be of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (be.getOperatorToken().getKind() !== SyntaxKind.InstanceOfKeyword) continue;
        const right = be.getRight();
        if (!Node.isIdentifier(right) || right.getText() !== localName) continue;
        const left = be.getLeft();
        if (Node.isIdentifier(left)) instanceofSubjects.add(left.getText());
    }
    for (const pa of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (pa.getName() !== 'code') continue;
        const obj = pa.getExpression();
        if (!Node.isIdentifier(obj) || !instanceofSubjects.has(obj.getText())) continue;
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                pa,
                `\`${obj.getText()}.code\` on an SdkHttpError is the SdkErrorCode string in v2; the HTTP status is on ` +
                    `\`${obj.getText()}.status\`. Update this check (e.g. \`.code === 404\` → \`.status === 404\`).`
            )
        );
    }

    let hasConstructorCalls = false;
    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;
        hasConstructorCalls = true;
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                node.getStartLineNumber(),
                'new StreamableHTTPError(statusCode, statusText, body?) → new SdkHttpError(code, message, data). ' +
                    'Constructor arguments differ — manual review required. Map the HTTP status to a SdkErrorCode enum value ' +
                    'and pass the HTTP status via the data argument, e.g. { status, statusText }.'
            )
        );
    }

    renameAllReferences(sourceFile, localName, 'SdkHttpError');
    changesCount++;

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
