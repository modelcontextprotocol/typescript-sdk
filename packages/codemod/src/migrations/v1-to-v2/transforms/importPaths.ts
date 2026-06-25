import type { SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { renameAllReferences } from '../../../utils/astUtils.js';
import { actionRequired, info, v2Gap, warning } from '../../../utils/diagnostics.js';
import type { NamedImportSpec } from '../../../utils/importUtils.js';
import { addOrMergeImport, getSdkExports, getSdkImports, isTypeOnlyImport } from '../../../utils/importUtils.js';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer.js';
import type { ImportMapping } from '../mappings/importMap.js';
import { isAuthImport, lookupImportMapping } from '../mappings/importMap.js';
import { SPEC_SCHEMA_NAMES } from '../mappings/specSchemaNames.js';
import { SIMPLE_RENAMES } from '../mappings/symbolMap.js';

const REEXPORT_WARNINGS: Record<string, string> = {
    ErrorCode: 'Re-exported ErrorCode was split into ProtocolErrorCode and SdkErrorCode in v2. Update this re-export manually.',
    RequestHandlerExtra:
        'Re-exported RequestHandlerExtra was renamed to ServerContext/ClientContext in v2. Update this re-export manually.',
    IsomorphicHeaders: 'Re-exported IsomorphicHeaders was removed in v2 (replaced by standard Headers API). Remove this re-export.',
    StreamableHTTPError:
        'Re-exported StreamableHTTPError was renamed to SdkHttpError in v2 with a different constructor. Update this re-export manually.'
};

/** The v2 name a symbol resolves to after renames (per-mapping override, then global SIMPLE_RENAMES). */
function resolveRenamedName(name: string, mapping: ImportMapping): string {
    return mapping.renamedSymbols?.[name] ?? SIMPLE_RENAMES[name] ?? name;
}

/**
 * The per-symbol target package for a symbol imported/re-exported from `mapping`'s module, or
 * `undefined` when the symbol should use the mapping's resolved `target`. Exact-name
 * `symbolTargetOverrides` win over `schemaSymbolTarget`, which routes a symbol to the shared-schemas
 * package only when its rename-resolved name is an actual spec schema constant (`SPEC_SCHEMA_NAMES`) —
 * not merely any name ending in `Schema`, so spec TYPES such as `BooleanSchema` resolve by context.
 */
function symbolTargetOverride(name: string, mapping: ImportMapping): string | undefined {
    if (mapping.symbolTargetOverrides && name in mapping.symbolTargetOverrides) {
        return mapping.symbolTargetOverrides[name];
    }
    if (mapping.schemaSymbolTarget && SPEC_SCHEMA_NAMES.has(resolveRenamedName(name, mapping))) {
        return mapping.schemaSymbolTarget;
    }
    return undefined;
}

export const importPathsTransform: Transform = {
    name: 'Import path rewrites',
    id: 'imports',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        const usedPackages = new Set<string>();
        let changesCount = 0;

        const sdkImports = getSdkImports(sourceFile);
        const sdkExports = getSdkExports(sourceFile);
        if (sdkImports.length === 0 && sdkExports.length === 0) {
            return { changesCount: 0, diagnostics: [] };
        }

        const filePath = sourceFile.getFilePath();

        changesCount += rewriteExportDeclarations(sdkExports, sourceFile, filePath, context, diagnostics, usedPackages);

        if (sdkImports.length === 0) {
            return { changesCount, diagnostics, usedPackages };
        }

        const hasClientImport = sdkImports.some(imp => {
            const spec = imp.getModuleSpecifierValue();
            return spec.includes('/client/');
        });
        const hasServerImport = sdkImports.some(imp => {
            const spec = imp.getModuleSpecifierValue();
            return spec.includes('/server/');
        });

        const insertIndex = sourceFile.getImportDeclarations().indexOf(sdkImports[0]!);

        // A leading file-header / JSDoc comment attaches to the first SDK import as leading trivia. When
        // that import is removed and re-emitted (the per-symbol split/merge path calls imp.remove()),
        // ts-morph drops the comment with it. Capture it now and restore it after emitting if it was lost.
        const leadingCommentText = sdkImports[0]!
            .getLeadingCommentRanges()
            .map(r => r.getText())
            .join('\n');

        interface PendingImport {
            specs: NamedImportSpec[];
            isTypeOnly: boolean;
        }
        const pendingImports = new Map<string, PendingImport[]>();

        function addPending(target: string, specs: NamedImportSpec[], isTypeOnly: boolean): void {
            if (!pendingImports.has(target)) {
                pendingImports.set(target, []);
            }
            pendingImports.get(target)!.push({ specs, isTypeOnly });
        }

        for (const imp of sdkImports) {
            const specifier = imp.getModuleSpecifierValue();
            const namedImports = imp.getNamedImports();
            const typeOnly = isTypeOnlyImport(imp);
            const line = imp.getStartLineNumber();
            const defaultImport = imp.getDefaultImport();
            const namespaceImport = imp.getNamespaceImport();

            let mapping = lookupImportMapping(specifier);

            if (!mapping && isAuthImport(specifier)) {
                mapping = {
                    target: '@modelcontextprotocol/server-legacy/auth',
                    status: 'moved',
                    migrationHint: 'Legacy auth module. For RS-only auth, see @modelcontextprotocol/express.'
                };
            }

            if (!mapping) {
                diagnostics.push(actionRequired(filePath, imp, `Unknown SDK import path: ${specifier}. Manual migration required.`));
                continue;
            }

            if (mapping.status === 'removed') {
                imp.remove();
                changesCount++;
                const diagFn = mapping.isV2Gap ? v2Gap : warning;
                diagnostics.push(diagFn(filePath, line, mapping.removalMessage ?? `Import removed: ${specifier}`));
                continue;
            }

            let targetPackage = mapping.target;
            if (targetPackage === 'RESOLVE_BY_CONTEXT') {
                targetPackage = resolveTypesPackage(context, hasClientImport, hasServerImport, {
                    filePath,
                    line,
                    diagnostics
                });
                if (mapping.subpathSuffix) {
                    targetPackage = `${targetPackage}${mapping.subpathSuffix}`;
                }
            }

            const symbolsToRenameInFile: Array<[string, string]> = [];
            if (mapping.renamedSymbols) {
                for (const [oldName, newName] of Object.entries(mapping.renamedSymbols)) {
                    const matchingImport = namedImports.find(n => n.getName() === oldName);
                    if (matchingImport && !matchingImport.getAliasNode()) {
                        symbolsToRenameInFile.push([oldName, newName]);
                    }
                }
            }

            // Default and namespace imports cannot be split per-symbol — the whole binding moves to one
            // package. Named imports (aliased or not) fall through to the per-symbol splitter below, so a
            // single aliased specifier no longer forces unrelated symbols into the wrong package.
            if (defaultImport || namespaceImport) {
                const effectiveTarget = targetPackage;
                // A namespace import (`import * as ns from '…/types.js'`) cannot be split per-symbol, so
                // any `ns.<Name>Schema` accesses would silently resolve against the wrong package. Flag them.
                if (namespaceImport && mapping.schemaSymbolTarget) {
                    const nsName = namespaceImport.getText();
                    const schemaNames = [
                        ...new Set(
                            sourceFile
                                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                                .filter(
                                    pa =>
                                        pa.getExpression().getText() === nsName &&
                                        SPEC_SCHEMA_NAMES.has(resolveRenamedName(pa.getName(), mapping))
                                )
                                .map(pa => pa.getName())
                        )
                    ];
                    if (schemaNames.length > 0) {
                        diagnostics.push(
                            actionRequired(
                                filePath,
                                imp,
                                `Namespace import of ${specifier} is used to access Zod schema(s) (${schemaNames.join(', ')}) that moved to ${mapping.schemaSymbolTarget}. ` +
                                    `Import them with a named import (e.g. \`import { ${schemaNames[0]} } from '${mapping.schemaSymbolTarget}'\`) and update the qualified usages.`
                            )
                        );
                    }
                }
                usedPackages.add(effectiveTarget);
                imp.setModuleSpecifier(effectiveTarget);
                if (mapping.renamedSymbols) {
                    for (const n of namedImports) {
                        const newName = mapping.renamedSymbols[n.getName()];
                        if (newName) {
                            n.setName(newName);
                        }
                    }
                    if (namespaceImport) {
                        diagnostics.push(
                            actionRequired(
                                filePath,
                                imp,
                                `Namespace import of ${specifier}: exported symbol(s) ${Object.keys(mapping.renamedSymbols).join(', ')} ` +
                                    `were renamed in ${effectiveTarget}. Update qualified accesses manually.`
                            )
                        );
                    }
                }
                changesCount++;
                if (mapping.migrationHint) {
                    diagnostics.push(info(filePath, line, mapping.migrationHint));
                }
                for (const [oldName, newName] of symbolsToRenameInFile) {
                    renameAllReferences(sourceFile, oldName, newName);
                }
                continue;
            }

            for (const n of namedImports) {
                const name = n.getName();
                const alias = n.getAliasNode()?.getText();
                const resolvedName = mapping.renamedSymbols?.[name] ?? name;
                const specifierTypeOnly = typeOnly || n.isTypeOnly();
                const symbolTarget = symbolTargetOverride(name, mapping) ?? targetPackage;
                usedPackages.add(symbolTarget);
                addPending(symbolTarget, [alias ? { name: resolvedName, alias } : resolvedName], specifierTypeOnly);
            }
            imp.remove();
            changesCount++;
            if (mapping.migrationHint) {
                diagnostics.push(info(filePath, line, mapping.migrationHint));
            }
            for (const [oldName, newName] of symbolsToRenameInFile) {
                renameAllReferences(sourceFile, oldName, newName);
            }
        }

        const specLocal = (spec: NamedImportSpec): string => (typeof spec === 'string' ? spec : (spec.alias ?? spec.name));
        for (const [target, groups] of pendingImports) {
            // Dedupe by local binding name (alias when present), keeping the spec so aliases survive.
            const typeOnlySpecs = new Map<string, NamedImportSpec>();
            const valueSpecs = new Map<string, NamedImportSpec>();
            for (const group of groups) {
                for (const spec of group.specs) {
                    (group.isTypeOnly ? typeOnlySpecs : valueSpecs).set(specLocal(spec), spec);
                }
            }

            if (valueSpecs.size > 0) {
                addOrMergeImport(sourceFile, target, [...valueSpecs.values()], false, insertIndex);
            }
            if (typeOnlySpecs.size > 0) {
                const typeInsertIndex = valueSpecs.size > 0 ? insertIndex + 1 : insertIndex;
                addOrMergeImport(sourceFile, target, [...typeOnlySpecs.values()], true, typeInsertIndex);
            }
        }

        // Restore the captured leading comment if the rewrite dropped it (guard against duplication when
        // the first import was rewritten in place and kept its comment).
        if (leadingCommentText && !sourceFile.getFullText().includes(leadingCommentText)) {
            const imports = sourceFile.getImportDeclarations();
            const anchor = imports[Math.min(insertIndex, imports.length - 1)];
            sourceFile.insertText(anchor ? anchor.getStart() : 0, `${leadingCommentText}\n`);
        }

        return { changesCount, diagnostics, usedPackages };
    }
};

function rewriteExportDeclarations(
    sdkExports: import('ts-morph').ExportDeclaration[],
    sourceFile: import('ts-morph').SourceFile,
    filePath: string,
    context: TransformContext,
    diagnostics: Diagnostic[],
    usedPackages: Set<string>
): number {
    let changesCount = 0;

    for (const exp of sdkExports) {
        const specifier = exp.getModuleSpecifierValue();
        if (!specifier) continue;

        const line = exp.getStartLineNumber();
        let mapping = lookupImportMapping(specifier);

        if (!mapping && isAuthImport(specifier)) {
            mapping = {
                target: '@modelcontextprotocol/server-legacy/auth',
                status: 'moved',
                migrationHint: 'Legacy auth module. For RS-only auth, see @modelcontextprotocol/express.'
            };
        }

        if (!mapping) {
            diagnostics.push(actionRequired(filePath, exp, `Unknown SDK export path: ${specifier}. Manual migration required.`));
            continue;
        }

        if (mapping.status === 'removed') {
            exp.remove();
            changesCount++;
            const diagFn = mapping.isV2Gap ? v2Gap : warning;
            diagnostics.push(diagFn(filePath, line, mapping.removalMessage ?? `Export removed: ${specifier}`));
            continue;
        }

        let targetPackage = mapping.target;
        if (targetPackage === 'RESOLVE_BY_CONTEXT') {
            const hasClientImport = sourceFile.getImportDeclarations().some(imp => {
                const spec = imp.getModuleSpecifierValue();
                return spec.includes('/client/') || spec === '@modelcontextprotocol/client';
            });
            const hasServerImport = sourceFile.getImportDeclarations().some(imp => {
                const spec = imp.getModuleSpecifierValue();
                return spec.includes('/server/') || spec === '@modelcontextprotocol/server';
            });
            targetPackage = resolveTypesPackage(context, hasClientImport, hasServerImport);
            if (mapping.subpathSuffix) {
                targetPackage = `${targetPackage}${mapping.subpathSuffix}`;
            }
        }

        if (mapping.symbolTargetOverrides || mapping.schemaSymbolTarget) {
            const namedExports = exp.getNamedExports();
            const overrides = namedExports.map(s => symbolTargetOverride(s.getName(), mapping));
            const uniqueOverrides = new Set(overrides.filter((t): t is string => t !== undefined));
            const allOverridden = namedExports.length > 0 && overrides.every(t => t !== undefined);
            if (allOverridden && uniqueOverrides.size === 1) {
                targetPackage = [...uniqueOverrides][0]!;
            } else if (uniqueOverrides.size > 0) {
                diagnostics.push(
                    actionRequired(
                        filePath,
                        exp,
                        `Re-export from ${specifier} mixes symbols that belong to different v2 packages. ` +
                            `Split the export manually so each symbol targets the correct package.`
                    )
                );
            }
        }
        usedPackages.add(targetPackage);
        exp.setModuleSpecifier(targetPackage);
        for (const spec of exp.getNamedExports()) {
            const name = spec.getName();
            const newName = mapping.renamedSymbols?.[name] ?? SIMPLE_RENAMES[name];
            if (newName) {
                if (!spec.getAliasNode()) spec.setAlias(name);
                spec.setName(newName);
            }
            if (REEXPORT_WARNINGS[name]) {
                diagnostics.push(actionRequired(filePath, exp, REEXPORT_WARNINGS[name]!));
            }
        }
        changesCount++;
        if (mapping.migrationHint) {
            diagnostics.push(info(filePath, line, mapping.migrationHint));
        }
    }

    return changesCount;
}
