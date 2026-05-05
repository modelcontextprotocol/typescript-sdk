import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import { SPEC_SCHEMA_NAMES, specSchemaToTypeName } from '../../../generated/specSchemaMap.js';
import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isAnyMcpSpecifier } from '../../../utils/importUtils.js';

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
            warning(
                sourceFile.getFilePath(),
                ref.getStartLineNumber(),
                `Replace \`z.infer<typeof ${localName}>\` with the \`${typeName}\` type (already exported from the same v2 package).`
            )
        );
        return false;
    }

    // Pattern: XSchema.safeParse(v).success — auto-transform to isSpecType.X(v)
    if (isSafeParseSuccessPattern(ref)) {
        const safeParseAccess = ref.getParent() as import('ts-morph').PropertyAccessExpression;
        const safeParseCall = safeParseAccess.getParent() as import('ts-morph').CallExpression;
        const successAccess = safeParseCall.getParent() as import('ts-morph').PropertyAccessExpression;
        const args = safeParseCall.getArguments();
        const argText = args.length > 0 ? args[0]!.getText() : '';
        successAccess.replaceWithText(`isSpecType.${typeName}(${argText})`);
        ensureImport(sourceFile, 'isSpecType');
        return true;
    }

    // Pattern: XSchema.safeParse(v) — result captured, diagnostic only
    if (isSafeParsePattern(ref)) {
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                ref.getStartLineNumber(),
                `${localName}.safeParse() not available in v2. Use \`isSpecType.${typeName}(value)\` for boolean validation, ` +
                    `or \`specTypeSchemas.${typeName}['~standard'].validate(value)\` for full result.`
            )
        );
        return false;
    }

    // Pattern: XSchema.parse(v) — diagnostic only
    if (isParsePattern(ref)) {
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                ref.getStartLineNumber(),
                `${localName}.parse() not available in v2. Use \`isSpecType.${typeName}(value)\` for validation, ` +
                    `or \`specTypeSchemas.${typeName}['~standard'].validate(value)\` and check for issues.`
            )
        );
        return false;
    }

    // Pattern: XSchema used as value (function arg, assignment, etc.)
    const parent = ref.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
        // Some other method call on the schema — diagnostic
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                ref.getStartLineNumber(),
                `${localName} is not exported in v2. Use \`specTypeSchemas.${typeName}\` (typed as StandardSchemaV1) or \`isSpecType.${typeName}\` for validation.`
            )
        );
        return false;
    }

    // Value position: replace identifier with specTypeSchemas.X
    const line = ref.getStartLineNumber();
    ref.replaceWithText(`specTypeSchemas.${typeName}`);
    ensureImport(sourceFile, 'specTypeSchemas');
    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            line,
            `Replaced ${localName} with specTypeSchemas.${typeName}. Note: typed as StandardSchemaV1, not ZodType — Zod methods like .safeParse()/.parse() are not available.`
        )
    );
    return true;
}

function isSafeParseSuccessPattern(ref: import('ts-morph').Node): boolean {
    const parent = ref.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) return false;
    if (parent.getName() !== 'safeParse' || parent.getExpression() !== ref) return false;
    const grandParent = parent.getParent();
    if (!grandParent || !Node.isCallExpression(grandParent)) return false;
    const greatGrandParent = grandParent.getParent();
    if (!greatGrandParent || !Node.isPropertyAccessExpression(greatGrandParent)) return false;
    return greatGrandParent.getName() === 'success';
}

function isSafeParsePattern(ref: import('ts-morph').Node): boolean {
    const parent = ref.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) return false;
    if (parent.getName() !== 'safeParse' || parent.getExpression() !== ref) return false;
    const grandParent = parent.getParent();
    return !!grandParent && Node.isCallExpression(grandParent);
}

function isParsePattern(ref: import('ts-morph').Node): boolean {
    const parent = ref.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) return false;
    if (parent.getName() !== 'parse' || parent.getExpression() !== ref) return false;
    const grandParent = parent.getParent();
    return !!grandParent && Node.isCallExpression(grandParent);
}

function isTypeofInTypePosition(ref: import('ts-morph').Node): boolean {
    const parent = ref.getParent();
    if (!parent) return false;
    if (Node.isTypeQuery(parent)) return true;
    // typeof inside a type argument like z.infer<typeof X>
    if (parent.getKind() === SyntaxKind.TypeOfExpression) return true;
    return false;
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
