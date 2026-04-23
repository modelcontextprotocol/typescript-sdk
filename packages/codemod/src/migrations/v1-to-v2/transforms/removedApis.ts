import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { renameAllReferences } from '../../../utils/astUtils.js';
import { warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isAnyMcpSpecifier } from '../../../utils/importUtils.js';

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

    const line = foundImportDecl.getStartLineNumber();

    renameAllReferences(sourceFile, 'IsomorphicHeaders', 'Headers');
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

    const line = foundImportDecl.getStartLineNumber();
    const moduleSpec = foundImportDecl.getModuleSpecifierValue();

    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== 'StreamableHTTPError') continue;
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                node.getStartLineNumber(),
                'new StreamableHTTPError(statusCode, statusText, body?) → new SdkError(code, message, data?). ' +
                    'Constructor arguments differ — manual review required. Map HTTP status to SdkErrorCode enum value.'
            )
        );
    }

    renameAllReferences(sourceFile, 'StreamableHTTPError', 'SdkError');
    changesCount++;

    foundImport.remove();
    if (foundImportDecl.getNamedImports().length === 0 && !foundImportDecl.getDefaultImport() && !foundImportDecl.getNamespaceImport()) {
        foundImportDecl.remove();
    }

    const targetModule = resolveTargetModule(sourceFile, moduleSpec);
    const insertIndex = sourceFile.getImportDeclarations().length;
    addOrMergeImport(sourceFile, targetModule, ['SdkError', 'SdkErrorCode'], false, insertIndex);
    changesCount++;

    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            line,
            'StreamableHTTPError replaced with SdkError. Constructor arguments differ — manual review required. ' +
                'HTTP status is now in error.data?.status.'
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
