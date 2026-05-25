import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import { SPEC_SCHEMA_NAMES, specSchemaToTypeName } from '../../../generated/specSchemaMap.js';
import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { isKeyPositionIdentifier } from '../../../utils/astUtils.js';
import { actionRequired, warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isAnyMcpSpecifier, removeUnusedImport } from '../../../utils/importUtils.js';

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

    // Pattern: const x = XSchema.safeParse(v) — auto-transform when result is captured in a variable
    if (isSafeParsePattern(ref)) {
        const safeParseAccess = ref.getParent() as import('ts-morph').PropertyAccessExpression;
        const safeParseCall = safeParseAccess.getParent() as import('ts-morph').CallExpression;

        if (isCapturedSafeParsePattern(safeParseCall)) {
            return rewriteCapturedSafeParse(safeParseCall, localName, typeName, sourceFile, diagnostics);
        }

        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                ref,
                `${localName}.safeParse() not available in v2. Use \`isSpecType.${typeName}(value)\` for boolean validation, ` +
                    `or \`specTypeSchemas.${typeName}['~standard'].validate(value)\` for full result.`
            )
        );
        return false;
    }

    // Pattern: XSchema.parse(v) — diagnostic only
    if (isParsePattern(ref)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                ref,
                `${localName}.parse() not available in v2. Use \`isSpecType.${typeName}(value)\` for validation, ` +
                    `or \`specTypeSchemas.${typeName}['~standard'].validate(value)\` and check for issues.`
            )
        );
        return false;
    }

    // Pattern: XSchema used as value (function arg, assignment, etc.)
    const parent = ref.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) {
        const line = ref.getStartLineNumber();
        ref.replaceWithText(`specTypeSchemas.${typeName}`);
        ensureImport(sourceFile, 'specTypeSchemas');
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                line,
                `Replaced ${localName} with specTypeSchemas.${typeName}. Note: typed as StandardSchemaV1, not ZodType — Zod methods like .safeParse()/.parse()/.parseAsync() are not available. Manual rewrite required.`
            )
        );
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
            warning(
                sourceFile.getFilePath(),
                line,
                `Replaced ${localName} with specTypeSchemas.${typeName}. Note: typed as StandardSchemaV1, not ZodType — Zod methods like .safeParse()/.parse() are not available.`
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
    return Node.isTypeQuery(parent);
}

/**
 * Checks if a safeParse call result is captured in a `const` variable declaration.
 * Pattern: `const x = Schema.safeParse(v);`
 */
function isCapturedSafeParsePattern(safeParseCall: import('ts-morph').CallExpression): boolean {
    const parent = safeParseCall.getParent();
    if (!parent || !Node.isVariableDeclaration(parent)) return false;
    const nameNode = parent.getNameNode();
    if (!Node.isIdentifier(nameNode)) return false;
    const declList = parent.getParent();
    if (!declList || !Node.isVariableDeclarationList(declList)) return false;
    const flags = declList.getDeclarationKind();
    return flags === 'const' || flags === 'let';
}

/**
 * Rewrites a captured safeParse pattern:
 *   const x = Schema.safeParse(v)  →  const x = specTypeSchemas.T['~standard'].validate(v)
 *   x.success  →  x.issues === undefined
 *   x.data     →  x.value
 *   x.error    →  x.issues
 */
function rewriteCapturedSafeParse(
    safeParseCall: import('ts-morph').CallExpression,
    localName: string,
    typeName: string,
    sourceFile: SourceFile,
    diagnostics: Diagnostic[]
): boolean {
    const varDecl = safeParseCall.getParent() as import('ts-morph').VariableDeclaration;
    const varName = varDecl.getName();

    const args = safeParseCall.getArguments();
    const argText = args.length > 0 ? args[0]!.getText() : '';

    // Rewrite the safeParse call
    safeParseCall.replaceWithText(`specTypeSchemas.${typeName}['~standard'].validate(${argText})`);
    ensureImport(sourceFile, 'specTypeSchemas');

    // Find and rewrite all property accesses on the result variable (scoped to declaring block)
    const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
    const scope = varDecl.getFirstAncestorByKind(SyntaxKind.Block) ?? sourceFile;
    scope.forEachDescendant(node => {
        if (!Node.isPropertyAccessExpression(node)) return;
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== varName) return;

        const propName = node.getName();
        switch (propName) {
            case 'success': {
                // Check for !x.success → x.issues !== undefined
                const parentNode = node.getParent();
                if (
                    parentNode &&
                    Node.isPrefixUnaryExpression(parentNode) &&
                    parentNode.getOperatorToken() === SyntaxKind.ExclamationToken
                ) {
                    replacements.push({ node: parentNode, newText: `${varName}.issues !== undefined` });
                } else {
                    replacements.push({ node, newText: `(${varName}.issues === undefined)` });
                }
                break;
            }
            case 'data': {
                replacements.push({ node, newText: `${varName}.value` });
                break;
            }
            case 'error': {
                const errorParent = node.getParent();
                if (errorParent && Node.isPropertyAccessExpression(errorParent) && errorParent.getExpression() === node) {
                    const subProp = errorParent.getName();
                    if (subProp === 'issues') {
                        replacements.push({ node: errorParent, newText: `${varName}.issues` });
                    } else if (subProp === 'message') {
                        replacements.push({ node: errorParent, newText: `${varName}.issues?.map(i => i.message).join(', ')` });
                    } else {
                        diagnostics.push(
                            actionRequired(
                                sourceFile.getFilePath(),
                                errorParent,
                                `${varName}.error.${subProp} has no StandardSchema equivalent. Manual migration required.`
                            )
                        );
                    }
                } else {
                    replacements.push({ node, newText: `${varName}.issues` });
                }
                break;
            }
        }
    });

    // Apply in reverse order to avoid position shifts
    const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
    for (const { node, newText } of sorted) {
        node.replaceWithText(newText);
    }

    diagnostics.push(
        warning(
            sourceFile.getFilePath(),
            varDecl.getStartLineNumber(),
            `Rewrote ${localName}.safeParse() to specTypeSchemas.${typeName}['~standard'].validate(). ` +
                `Result properties remapped: .success → .issues === undefined, .data → .value, .error → .issues.`
        )
    );

    return true;
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
