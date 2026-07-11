import type { Node, SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { findFirstIdentifierOutsideImports, renameAllReferences } from '../../../utils/astUtils';
import { actionRequired, info, v2Gap, warning } from '../../../utils/diagnostics';
import type { NamedImportSpec } from '../../../utils/importUtils';
import { addOrMergeImport, getSdkExports, getSdkImports, isTypeOnlyImport } from '../../../utils/importUtils';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer';
import { AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT } from '../mappings/authSchemaNames';
import { isAuthImport, lookupImportMapping, RS_ONLY_AUTH_SYMBOLS } from '../mappings/importMap';
import { isSharedSchemaConst, resolveRenamedName, symbolTargetOverride } from '../mappings/schemaRouting';
import { SIMPLE_RENAMES } from '../mappings/symbolMap';

const REEXPORT_WARNINGS: Record<string, string> = {
    ErrorCode: 'Re-exported ErrorCode was split into ProtocolErrorCode and SdkErrorCode in v2. Update this re-export manually.',
    RequestHandlerExtra:
        'Re-exported RequestHandlerExtra was renamed to ServerContext/ClientContext in v2. Update this re-export manually.',
    IsomorphicHeaders: 'Re-exported IsomorphicHeaders was removed in v2 (replaced by standard Headers API). Remove this re-export.',
    StreamableHTTPError:
        'Re-exported StreamableHTTPError was renamed to SdkHttpError in v2 with a different constructor. Update this re-export manually.'
};

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
        // Capture the EXACT source bytes spanning all leading comment ranges (first range's start to last
        // range's end) rather than re-joining each range with '\n' — a join drops the original separators
        // (a blank line, or CRLF in CRLF files), so the later survival check would never match a header
        // that actually survived (in-place setModuleSpecifier rewrite) and would re-insert it, duplicating
        // it. The slice reproduces the block verbatim, so the includes() guard below is byte-exact.
        const leadingRanges = sdkImports[0]!.getLeadingCommentRanges();
        const leadingCommentText =
            leadingRanges.length > 0 ? sourceFile.getFullText().slice(leadingRanges[0]!.getPos(), leadingRanges.at(-1)!.getEnd()) : '';

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

            // Resource-server helpers have a maintained v2 home in @modelcontextprotocol/express;
            // the server-legacy/auth copy they are routed to is a frozen v1 snapshot. The re-point
            // is a judgment call (the express middleware answers verifier throws of the v1 error
            // classes with a generic 500, so verifiers must move to the v2 OAuthError with it) —
            // mark the import so the call sites get looked at instead of quietly staying on legacy.
            if (mapping.target === '@modelcontextprotocol/server-legacy/auth') {
                const matched = namedImports.filter(n => RS_ONLY_AUTH_SYMBOLS.has(n.getName()));
                const valueMatchedSpecifiers = matched.filter(n => !typeOnly && !n.isTypeOnly());
                const valueMatched = valueMatchedSpecifiers.map(n => n.getName());
                const typeMatched = matched.filter(n => typeOnly || n.isTypeOnly()).map(n => n.getName());
                if (valueMatched.length > 0) {
                    // The marker must outlive this pass: the import declaration it
                    // describes is removed when the path is rerouted, so anchor at the
                    // first use of one of the helpers (the import line otherwise).
                    const usageAnchor =
                        valueMatchedSpecifiers
                            .map(n => findFirstIdentifierOutsideImports(sourceFile, n.getAliasNode()?.getText() ?? n.getName()))
                            .find(node => node !== undefined) ?? imp;
                    diagnostics.push(
                        actionRequired(
                            filePath,
                            usageAnchor,
                            `${valueMatched.join(', ')}: resource-server auth helpers routed to the frozen ` +
                                `@modelcontextprotocol/server-legacy/auth copy. The maintained v2 home is ` +
                                `@modelcontextprotocol/express — when re-pointing, verifiers must throw the v2 OAuthError ` +
                                `(the express middleware does not recognize the legacy error classes). ` +
                                `See the migration guide's server auth split section.`
                        )
                    );
                }
                if (typeMatched.length > 0) {
                    diagnostics.push(
                        info(
                            filePath,
                            line,
                            `${typeMatched.join(', ')}: type-only import routed to @modelcontextprotocol/server-legacy/auth; ` +
                                `the maintained v2 type lives in @modelcontextprotocol/express — re-point when convenient.`
                        )
                    );
                }
            }

            if (mapping.status === 'removed') {
                imp.remove();
                changesCount++;
                const diagFn = mapping.isV2Gap ? v2Gap : warning;
                diagnostics.push(diagFn(filePath, line, mapping.removalMessage ?? `Import removed: ${specifier}`));
                continue;
            }

            // Resolve a RESOLVE_BY_CONTEXT mapping (sdk/types.js, sdk/shared/auth.js) only when a binding
            // actually routes to the context package. resolveTypesPackage's diagnostic sink emits a "could
            // not determine project type" warning (or, for a 'both' project, an info note), so resolving
            // eagerly would emit that note even for an import of nothing but `*Schema` constants — which
            // routes entirely to core and never uses the context package. A namespace or default
            // binding always needs context; a named symbol needs it only when it has no per-symbol override
            // (i.e. it is not a `*Schema` routed to core).
            let targetPackage = mapping.target;
            if (targetPackage === 'RESOLVE_BY_CONTEXT') {
                const needsContext =
                    namespaceImport != null ||
                    defaultImport != null ||
                    namedImports.some(
                        n =>
                            mapping!.removedSymbols?.[n.getName()] === undefined &&
                            symbolTargetOverride(n.getName(), mapping!) === undefined
                    );
                if (needsContext) {
                    const base = resolveTypesPackage(context, hasClientImport, hasServerImport, { filePath, line, diagnostics });
                    targetPackage = mapping.subpathSuffix ? `${base}${mapping.subpathSuffix}` : base;
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

            // A namespace import (`import * as ns from …`) cannot be split per-symbol — usages are
            // qualified (`ns.Foo`), so the whole binding moves to one package. Named imports (aliased or
            // not), including the named siblings of a default import, DO fall through to the per-symbol
            // splitter below — so an all-`*Schema` import routes entirely to core, a single aliased
            // specifier no longer forces unrelated symbols into the wrong package, and a mixed
            // `import sdk, { CallToolResultSchema }` routes the schema to core while the default
            // binding (handled at the end of the per-symbol path) moves to the context package.
            if (namespaceImport) {
                const effectiveTarget = targetPackage;
                // Any `ns.<Name>Schema` accesses would silently resolve against the wrong package (the
                // namespace can't be split), so flag them.
                if (mapping.schemaSymbolTarget) {
                    const nsName = namespaceImport.getText();
                    // Map each accessed v1 name to the v2 name core actually exports — some are
                    // renamed (e.g. JSONRPCErrorSchema → JSONRPCErrorResponseSchema), and core only
                    // exports the v2 name. Dedupe by the accessed (v1) name.
                    const schemaAccesses = [
                        ...new Map(
                            sourceFile
                                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                                .filter(pa => pa.getExpression().getText() === nsName && isSharedSchemaConst(pa.getName(), mapping))
                                .map(pa => [pa.getName(), resolveRenamedName(pa.getName(), mapping)] as const)
                        )
                    ];
                    if (schemaAccesses.length > 0) {
                        const accessed = schemaAccesses.map(([v1]) => v1).join(', ');
                        const importName = schemaAccesses[0]![1];
                        const renamed = schemaAccesses.filter(([v1, v2]) => v1 !== v2);
                        const renameNote =
                            renamed.length > 0 ? ` Renamed in v2: ${renamed.map(([v1, v2]) => `${v1} → ${v2}`).join(', ')}.` : '';
                        diagnostics.push(
                            actionRequired(
                                filePath,
                                imp,
                                `Namespace import of ${specifier} is used to access Zod schema(s) (${accessed}) that moved to ${mapping.schemaSymbolTarget}.${renameNote} ` +
                                    `Import them with a named import (e.g. \`import { ${importName} } from '${mapping.schemaSymbolTarget}'\`) and update the qualified usages.`
                            )
                        );
                    }
                }
                // Qualified accesses to symbols with no v2 export (`ns.Protocol`) can't be fixed by
                // moving the namespace binding — flag each accessed one. Expression positions are
                // PropertyAccessExpressions; type positions (`let p: ns.Protocol`) are QualifiedNames.
                if (mapping.removedSymbols) {
                    const nsName = namespaceImport.getText();
                    const accessedRemoved = new Map<string, Node>();
                    for (const pa of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
                        const memberName = pa.getName();
                        if (
                            pa.getExpression().getText() === nsName &&
                            mapping.removedSymbols[memberName] !== undefined &&
                            !accessedRemoved.has(memberName)
                        ) {
                            accessedRemoved.set(memberName, pa);
                        }
                    }
                    for (const qn of sourceFile.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
                        const memberName = qn.getRight().getText();
                        if (
                            qn.getLeft().getText() === nsName &&
                            mapping.removedSymbols[memberName] !== undefined &&
                            !accessedRemoved.has(memberName)
                        ) {
                            accessedRemoved.set(memberName, qn);
                        }
                    }
                    for (const [name, node] of accessedRemoved) {
                        diagnostics.push(actionRequired(filePath, node, mapping.removedSymbols[name]!));
                    }
                }
                usedPackages.add(effectiveTarget);
                imp.setModuleSpecifier(effectiveTarget);
                if (mapping.renamedSymbols) {
                    diagnostics.push(
                        actionRequired(
                            filePath,
                            imp,
                            `Namespace import of ${specifier}: exported symbol(s) ${Object.keys(mapping.renamedSymbols).join(', ')} ` +
                                `were renamed in ${effectiveTarget}. Update qualified accesses manually.`
                        )
                    );
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
                const removalGuidance = mapping.removedSymbols?.[name];
                if (removalGuidance !== undefined) {
                    // No v2 package exports this symbol — dropping it (with a marker) beats
                    // emitting an import of a member the target package does not have. Anchor
                    // the marker to a usage site: it survives the import rewrites, so the
                    // runner resolves a live line, and it is where the user must act anyway.
                    const usageName = n.getAliasNode()?.getText() ?? name;
                    diagnostics.push(
                        actionRequired(filePath, findFirstIdentifierOutsideImports(sourceFile, usageName) ?? imp, removalGuidance)
                    );
                    continue;
                }
                const alias = n.getAliasNode()?.getText();
                const resolvedName = mapping.renamedSymbols?.[name] ?? name;
                const specifierTypeOnly = typeOnly || n.isTypeOnly();
                const symbolTarget = symbolTargetOverride(name, mapping) ?? targetPackage;
                // A v1 auth-schema constant with no public v2 home (SafeUrlSchema/OptionalSafeUrlSchema)
                // routes by context to a package that doesn't export it. Flag it so the user inlines the
                // validation instead of hitting a silent "has no exported member" error.
                if (mapping.schemaSymbolTarget && AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT.has(name)) {
                    diagnostics.push(
                        actionRequired(
                            filePath,
                            imp,
                            `${name} was an internal URL field-validator in v1's ${specifier} with no public v2 equivalent ` +
                                `(it is not re-exported by @modelcontextprotocol/core). Remove this import and inline the ` +
                                `validation (e.g. validate the URL with the WHATWG \`URL\` constructor or your own Zod schema).`
                        )
                    );
                }
                usedPackages.add(symbolTarget);
                addPending(symbolTarget, [alias ? { name: resolvedName, alias } : resolvedName], specifierTypeOnly);
            }
            if (defaultImport) {
                // The default binding can't be split per-symbol, so move it (and the module specifier) to
                // the resolved context/target package. The named siblings were just routed per-symbol
                // above, so drop them from this now default-only import.
                const effectiveTarget = targetPackage;
                usedPackages.add(effectiveTarget);
                if (namedImports.length > 0) {
                    imp.removeNamedImports();
                }
                imp.setModuleSpecifier(effectiveTarget);
            } else {
                imp.remove();
            }
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

        // A star re-export of a module with removed symbols silently drops them from the
        // barrel (the new target never exported them) — flag each, mirroring the
        // schema-constant star-export diagnostic below.
        if (mapping.removedSymbols && exp.getNamedExports().length === 0) {
            for (const [name, guidance] of Object.entries(mapping.removedSymbols)) {
                diagnostics.push(
                    actionRequired(filePath, exp, `Star re-export of ${specifier} will no longer provide ${name}. ${guidance}`)
                );
            }
        }

        if (mapping.symbolTargetOverrides || mapping.schemaSymbolTarget) {
            const namedExports = exp.getNamedExports();
            // A star re-export (`export * from …`, including `export * as ns from …`) has no named
            // exports to route per-symbol, so it moves wholesale to the context package — which exports
            // none of the Zod `*Schema` constants the v1 module re-exported. Downstream consumers of this
            // barrel would hit "has no exported member" with no pointer to where the schemas went, so flag
            // it (mirroring the namespace-import diagnostic on the import side).
            if (mapping.schemaSymbolTarget && namedExports.length === 0) {
                diagnostics.push(
                    actionRequired(
                        filePath,
                        exp,
                        `Star re-export of ${specifier} will not include the Zod schema constants that moved to ` +
                            `${mapping.schemaSymbolTarget} (they are no longer exported by ${targetPackage}). ` +
                            `Add an explicit \`export { … } from '${mapping.schemaSymbolTarget}'\` for any re-exported \`*Schema\` constants.`
                    )
                );
            }
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
            const removalGuidance = mapping.removedSymbols?.[name];
            if (removalGuidance !== undefined) {
                diagnostics.push(
                    actionRequired(filePath, exp, `Re-exported ${name} has no v2 export — remove this re-export. ${removalGuidance}`)
                );
            } else if (RS_ONLY_AUTH_SYMBOLS.has(name) && targetPackage === '@modelcontextprotocol/server-legacy/auth') {
                diagnostics.push(
                    actionRequired(
                        filePath,
                        exp,
                        `Re-exported ${name} now points at the frozen @modelcontextprotocol/server-legacy/auth copy; the ` +
                            `maintained v2 home is @modelcontextprotocol/express. Re-point this barrel entry deliberately.`
                    )
                );
            } else if (REEXPORT_WARNINGS[name]) {
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
