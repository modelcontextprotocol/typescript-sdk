import type { SourceFile } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types.js';
import { renameAllReferences } from '../../../utils/astUtils.js';
import { warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, getSdkExports, getSdkImports, isTypeOnlyImport } from '../../../utils/importUtils.js';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer.js';
import { IMPORT_MAP, isAuthImport } from '../mappings/importMap.js';
import { SIMPLE_RENAMES } from '../mappings/symbolMap.js';

const REEXPORT_WARNINGS: Record<string, string> = {
    ErrorCode: 'Re-exported ErrorCode was split into ProtocolErrorCode and SdkErrorCode in v2. Update this re-export manually.',
    RequestHandlerExtra:
        'Re-exported RequestHandlerExtra was renamed to ServerContext/ClientContext in v2. Update this re-export manually.',
    IsomorphicHeaders: 'Re-exported IsomorphicHeaders was removed in v2 (replaced by standard Headers API). Remove this re-export.',
    StreamableHTTPError:
        'Re-exported StreamableHTTPError was renamed to SdkError in v2 with different constructor. Update this re-export manually.'
};

export const importPathsTransform: Transform = {
    name: 'Import path rewrites',
    id: 'imports',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: ReturnType<typeof warning>[] = [];
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

        interface PendingImport {
            names: string[];
            isTypeOnly: boolean;
        }
        const pendingImports = new Map<string, PendingImport[]>();

        function addPending(target: string, names: string[], isTypeOnly: boolean): void {
            if (!pendingImports.has(target)) {
                pendingImports.set(target, []);
            }
            pendingImports.get(target)!.push({ names, isTypeOnly });
        }

        for (const imp of sdkImports) {
            const specifier = imp.getModuleSpecifierValue();
            const namedImports = imp.getNamedImports();
            const typeOnly = isTypeOnlyImport(imp);
            const line = imp.getStartLineNumber();
            const defaultImport = imp.getDefaultImport();
            const namespaceImport = imp.getNamespaceImport();

            let mapping = IMPORT_MAP[specifier];

            if (!mapping && isAuthImport(specifier)) {
                mapping = {
                    target: '',
                    status: 'removed',
                    removalMessage: 'Server auth removed in v2. Use an external auth library (e.g., better-auth).'
                };
            }

            if (!mapping) {
                diagnostics.push(warning(filePath, line, `Unknown SDK import path: ${specifier}. Manual migration required.`));
                continue;
            }

            if (mapping.status === 'removed') {
                imp.remove();
                changesCount++;
                diagnostics.push(warning(filePath, line, mapping.removalMessage ?? `Import removed: ${specifier}`));
                continue;
            }

            let targetPackage = mapping.target;
            if (targetPackage === 'RESOLVE_BY_CONTEXT') {
                targetPackage = resolveTypesPackage(context, hasClientImport, hasServerImport);
            }

            if (mapping.renamedSymbols) {
                for (const [oldName, newName] of Object.entries(mapping.renamedSymbols)) {
                    renameAllReferences(sourceFile, oldName, newName);
                }
            }

            const hasAlias = namedImports.some(n => n.getAliasNode() !== undefined);
            if (defaultImport || namespaceImport || hasAlias) {
                let effectiveTarget = targetPackage;
                if (mapping.symbolTargetOverrides && !namespaceImport && !defaultImport) {
                    const allOverridden = namedImports.length > 0 && namedImports.every(n => n.getName() in mapping.symbolTargetOverrides!);
                    if (allOverridden) {
                        effectiveTarget = mapping.symbolTargetOverrides[namedImports[0]!.getName()]!;
                    } else if (namedImports.some(n => n.getName() in mapping.symbolTargetOverrides!)) {
                        diagnostics.push(
                            warning(
                                filePath,
                                line,
                                `Aliased import from ${specifier} mixes symbols that belong to different v2 packages. ` +
                                    `Split the import manually so each symbol targets the correct package.`
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
                            warning(
                                filePath,
                                line,
                                `Namespace import of ${specifier}: exported symbol(s) ${Object.keys(mapping.renamedSymbols).join(', ')} ` +
                                    `were renamed in ${effectiveTarget}. Update qualified accesses manually.`
                            )
                        );
                    }
                }
                changesCount++;
                continue;
            }

            for (const n of namedImports) {
                const name = n.getName();
                const resolvedName = mapping.renamedSymbols?.[name] ?? name;
                const specifierTypeOnly = typeOnly || n.isTypeOnly();
                const symbolTarget = mapping.symbolTargetOverrides?.[name] ?? targetPackage;
                usedPackages.add(symbolTarget);
                addPending(symbolTarget, [resolvedName], specifierTypeOnly);
            }
            imp.remove();
            changesCount++;
        }

        for (const [target, groups] of pendingImports) {
            const typeOnlyNames = new Set<string>();
            const valueNames = new Set<string>();
            for (const group of groups) {
                for (const name of group.names) {
                    if (group.isTypeOnly) {
                        typeOnlyNames.add(name);
                    } else {
                        valueNames.add(name);
                    }
                }
            }

            if (valueNames.size > 0) {
                addOrMergeImport(sourceFile, target, [...valueNames], false, insertIndex);
            }
            if (typeOnlyNames.size > 0) {
                const typeInsertIndex = valueNames.size > 0 ? insertIndex + 1 : insertIndex;
                addOrMergeImport(sourceFile, target, [...typeOnlyNames], true, typeInsertIndex);
            }
        }

        return { changesCount, diagnostics, usedPackages };
    }
};

function rewriteExportDeclarations(
    sdkExports: import('ts-morph').ExportDeclaration[],
    sourceFile: import('ts-morph').SourceFile,
    filePath: string,
    context: TransformContext,
    diagnostics: ReturnType<typeof warning>[],
    usedPackages: Set<string>
): number {
    let changesCount = 0;

    for (const exp of sdkExports) {
        const specifier = exp.getModuleSpecifierValue();
        if (!specifier) continue;

        const line = exp.getStartLineNumber();
        let mapping = IMPORT_MAP[specifier];

        if (!mapping && isAuthImport(specifier)) {
            mapping = {
                target: '',
                status: 'removed',
                removalMessage: 'Server auth removed in v2. Use an external auth library (e.g., better-auth).'
            };
        }

        if (!mapping) {
            diagnostics.push(warning(filePath, line, `Unknown SDK export path: ${specifier}. Manual migration required.`));
            continue;
        }

        if (mapping.status === 'removed') {
            exp.remove();
            changesCount++;
            diagnostics.push(warning(filePath, line, mapping.removalMessage ?? `Export removed: ${specifier}`));
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
        }

        if (mapping.symbolTargetOverrides) {
            const namedExports = exp.getNamedExports();
            const allOverridden = namedExports.length > 0 && namedExports.every(s => s.getName() in mapping.symbolTargetOverrides!);
            if (allOverridden) {
                targetPackage = mapping.symbolTargetOverrides[namedExports[0]!.getName()]!;
            } else if (namedExports.some(s => s.getName() in mapping.symbolTargetOverrides!)) {
                diagnostics.push(
                    warning(
                        filePath,
                        line,
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
                diagnostics.push(warning(filePath, line, REEXPORT_WARNINGS[name]!));
            }
        }
        changesCount++;
    }

    return changesCount;
}
