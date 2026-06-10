import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

import { SPEC_SCHEMA_NAMES, specSchemaToTypeName } from '../../../generated/specSchemaMap.js';
import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { isKeyPositionIdentifier } from '../../../utils/astUtils.js';
import { actionRequired, info } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isAnyMcpSpecifier, removeUnusedImport } from '../../../utils/importUtils.js';

/**
 * Methods that the v2 `specTypeSchemas.X` map exposes with the same behavior they had on the v1
 * top-level Zod schemas. Renaming `XSchema.<m>(...)` to `specTypeSchemas.X.<m>(...)` for these is a
 * pure, behavior-preserving substitution; other Zod methods (`.extend`, `.or`, `.parseAsync`, …) are
 * not on the Standard-Schema-typed entry and need manual attention.
 */
const ZOD_COMPATIBLE_METHODS = new Set(['parse', 'safeParse']);

export const specSchemaAccessTransform: Transform = {
    name: 'Spec schema standalone usage',
    id: 'spec-schemas',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        const schemaImports = collectSpecSchemaImports(sourceFile);
        if (schemaImports.size === 0) return { changesCount: 0, diagnostics: [] };

        for (const [localName, originalName] of schemaImports) {
            const typeName = specSchemaToTypeName(originalName);
            if (!typeName) continue;

            const refs = findNonImportReferences(sourceFile, localName);
            if (refs.length === 0) continue;

            for (const ref of refs) {
                const result = handleReference(ref, localName, typeName, sourceFile, diagnostics);
                if (result) changesCount++;
            }
            removeUnusedImport(sourceFile, localName, true);
        }

        return { changesCount, diagnostics };
    }
};

function collectSpecSchemaImports(sourceFile: SourceFile): Map<string, string> {
    const result = new Map<string, string>();
    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const n of imp.getNamedImports()) {
            const exportName = n.getName();
            if (!SPEC_SCHEMA_NAMES.has(exportName)) continue;
            const localName = n.getAliasNode()?.getText() ?? exportName;
            result.set(localName, exportName);
        }
    }
    return result;
}

function findNonImportReferences(sourceFile: SourceFile, localName: string): import('ts-morph').Node[] {
    const refs: import('ts-morph').Node[] = [];
    sourceFile.forEachDescendant(node => {
        if (!Node.isIdentifier(node)) return;
        if (node.getText() !== localName) return;
        const parent = node.getParent();
        if (parent && Node.isImportSpecifier(parent)) return;
        refs.push(node);
    });
    return refs;
}

function handleReference(
    ref: import('ts-morph').Node,
    localName: string,
    typeName: string,
    sourceFile: SourceFile,
    diagnostics: Diagnostic[]
): boolean {
    // Pattern: z.infer<typeof XSchema> — type position
    if (isTypeofInTypePosition(ref)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                ref,
                `Replace \`z.infer<typeof ${localName}>\` with the \`${typeName}\` type (already exported from the same v2 package).`
            )
        );
        return false;
    }

    // Pattern: XSchema.<method>(...) — rename the schema reference to specTypeSchemas.X and keep the
    // method call. For `.parse()`/`.safeParse()` this is a behavior-preserving rename (those methods
    // are exposed on the v2 entry); for other Zod methods the call will not typecheck and needs a
    // manual rewrite, so the diagnostic severity reflects which case applies.
    const parent = ref.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
        const methodName = parent.getName();
        const line = ref.getStartLineNumber();
        ref.replaceWithText(`specTypeSchemas.${typeName}`);
        ensureImport(sourceFile, 'specTypeSchemas');
        if (ZOD_COMPATIBLE_METHODS.has(methodName)) {
            diagnostics.push(
                info(
                    sourceFile.getFilePath(),
                    line,
                    `Renamed ${localName} to specTypeSchemas.${typeName}. .${methodName}() is preserved and behaves as before ` +
                        `(throws a ZodError on invalid input for .parse()); no result remapping needed.`
                )
            );
        } else {
            // .${methodName}() is not exposed on the Standard-Schema-typed entry, so the renamed call
            // will not typecheck — flag it inline for manual migration.
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    parent,
                    `${localName}.${methodName}() has no equivalent on specTypeSchemas.${typeName}. Only .parse()/.safeParse() and ` +
                        `the Standard Schema interface (['~standard']) are exposed — rewrite this call manually.`
                )
            );
        }
        return true;
    }

    if (parent && Node.isExportSpecifier(parent)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                ref,
                `Re-export of ${localName} requires manual update: replace with specTypeSchemas.${typeName} or remove.`
            )
        );
        return false;
    }

    if (parent && Node.isShorthandPropertyAssignment(parent)) {
        const line = ref.getStartLineNumber();
        parent.replaceWithText(`'${localName}': specTypeSchemas.${typeName}`);
        ensureImport(sourceFile, 'specTypeSchemas');
        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                line,
                `Renamed ${localName} to specTypeSchemas.${typeName}. It exposes .parse()/.safeParse() and the Standard Schema ` +
                    `interface; other Zod schema methods are not available.`
            )
        );
        return true;
    }

    if (parent && isKeyPositionIdentifier(ref)) {
        return false;
    }

    // Value position: replace identifier with specTypeSchemas.X
    const line = ref.getStartLineNumber();
    ref.replaceWithText(`specTypeSchemas.${typeName}`);
    ensureImport(sourceFile, 'specTypeSchemas');
    diagnostics.push(
        info(
            sourceFile.getFilePath(),
            line,
            `Renamed ${localName} to specTypeSchemas.${typeName}. It exposes .parse()/.safeParse() and the Standard Schema ` +
                `interface; other Zod schema methods are not available.`
        )
    );
    return true;
}

function isTypeofInTypePosition(ref: import('ts-morph').Node): boolean {
    const parent = ref.getParent();
    if (!parent) return false;
    return Node.isTypeQuery(parent);
}

function ensureImport(sourceFile: SourceFile, symbol: string): void {
    const existingImport = sourceFile.getImportDeclarations().find(imp => {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) return false;
        return imp.getNamedImports().some(n => n.getName() === symbol);
    });
    if (existingImport) return;

    const targetPkg = sourceFile.getImportDeclarations().find(imp => {
        const spec = imp.getModuleSpecifierValue();
        return spec === '@modelcontextprotocol/server' || spec === '@modelcontextprotocol/client';
    });
    const target = targetPkg?.getModuleSpecifierValue() ?? '@modelcontextprotocol/server';
    addOrMergeImport(sourceFile, target, [symbol], false, sourceFile.getImportDeclarations().length);
}
