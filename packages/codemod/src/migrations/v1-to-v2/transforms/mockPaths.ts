import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { actionRequired, v2Gap, warning } from '../../../utils/diagnostics';
import { isSdkSpecifier } from '../../../utils/importUtils';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer';
import type { ImportMapping } from '../mappings/importMap';
import { isAuthImport, lookupImportMapping } from '../mappings/importMap';
import { isSharedSchemaConst, resolveRenamedName, symbolTargetOverride } from '../mappings/schemaRouting';
import { SIMPLE_RENAMES } from '../mappings/symbolMap';

/**
 * Resolve the single per-symbol target package shared by every `symbol` (mocked factory keys or
 * destructured `import()` bindings), or report that they mix v2 packages. A mock/dynamic-import
 * specifier is a single string and cannot be split, so a mix can only be flagged, not rewritten.
 * Returns `target: undefined` when no symbol carries a per-symbol override (the caller keeps the
 * mapping's resolved context/`target` package). Mirrors `symbolTargetOverride` routing used by the
 * static import/export transform so e.g. a factory of only `*Schema` constants routes to core.
 */
function routeSymbols(symbols: string[], mapping: ImportMapping): { target?: string; mixed: boolean } {
    if (symbols.length === 0) return { mixed: false };
    const targets = symbols.map(s => symbolTargetOverride(s, mapping));
    const overridden = targets.filter((t): t is string => t !== undefined);
    const unique = new Set(overridden);
    if (overridden.length === symbols.length && unique.size === 1) return { target: [...unique][0]!, mixed: false };
    if (unique.size > 0) return { mixed: true };
    return { mixed: false };
}

const MOCK_METHODS = new Set([
    'mock',
    'doMock',
    'unmock',
    'dontMock',
    'deepUnmock',
    'requireActual',
    'importActual',
    'requireMock',
    'createMockFromModule'
]);
const MOCK_CALLERS = new Set(['vi', 'jest']);

export const mockPathsTransform: Transform = {
    name: 'Mock and dynamic import path rewrites',
    id: 'mock-paths',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        const usedPackages = new Set<string>();
        let changesCount = 0;

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const call of calls) {
            const expr = call.getExpression();

            if (Node.isPropertyAccessExpression(expr)) {
                const objName = expr.getExpression().getText();
                const methodName = expr.getName();
                if (MOCK_CALLERS.has(objName) && MOCK_METHODS.has(methodName)) {
                    changesCount += rewriteMockCall(call, sourceFile, context, diagnostics, usedPackages);
                }
            }
        }

        changesCount += rewriteDynamicImports(sourceFile, context, diagnostics, usedPackages);

        return { changesCount, diagnostics, usedPackages };
    }
};

function resolveTarget(
    specifier: string,
    context: TransformContext,
    sourceFile: SourceFile,
    symbols: string[],
    diagnosticSink?: { filePath: string; line: number; diagnostics: Diagnostic[] }
): { target: string; mapping: ImportMapping } | { removed: true; isV2Gap?: boolean; removalMessage?: string } | null {
    const mapping = lookupImportMapping(specifier);
    if (!mapping && isAuthImport(specifier)) {
        const authMapping: ImportMapping = { target: '@modelcontextprotocol/server-legacy/auth', status: 'moved' };
        return { target: authMapping.target, mapping: authMapping };
    }
    if (!mapping) return null;
    if (mapping.status === 'removed') return { removed: true, isV2Gap: mapping.isV2Gap, removalMessage: mapping.removalMessage };

    let target = mapping.target;
    if (target === 'RESOLVE_BY_CONTEXT') {
        const hasClient = sourceFile.getImportDeclarations().some(i => {
            const s = i.getModuleSpecifierValue();
            return s.includes('/client/') || s === '@modelcontextprotocol/client';
        });
        const hasServer = sourceFile.getImportDeclarations().some(i => {
            const s = i.getModuleSpecifierValue();
            return s.includes('/server/') || s === '@modelcontextprotocol/server';
        });
        // Resolve lazily: only pass the diagnostic sink to resolveTypesPackage when the routed target
        // actually falls back to the context package. A factory/destructuring whose symbols all route
        // elsewhere (e.g. only `*Schema` constants → core) never uses the context package, so emitting a
        // "could not determine project type" warning (or a 'both'-project info note) for it would be
        // spurious. Mirrors the lazy `needsContext` guard in the static import transform. A
        // non-destructured/non-routable binding has no symbols, so `routeSymbols` returns no target and
        // context is (correctly) treated as needed.
        const needsContext = routeSymbols(symbols, mapping).target === undefined;
        target = resolveTypesPackage(context, hasClient, hasServer, needsContext ? diagnosticSink : undefined);
        if (mapping.subpathSuffix) {
            target = `${target}${mapping.subpathSuffix}`;
        }
    }

    // Return the original mapping (not just `renamedSymbols`/`symbolTargetOverrides`) so per-symbol
    // routing can consult `schemaSymbolTarget` via the shared `symbolTargetOverride`/`routeSymbols`,
    // matching how the static import transform routes `*Schema` constants to core.
    return { target, mapping };
}

function rewriteMockCall(
    call: import('ts-morph').CallExpression,
    sourceFile: SourceFile,
    context: TransformContext,
    diagnostics: Diagnostic[],
    usedPackages: Set<string>
): number {
    const args = call.getArguments();
    if (args.length === 0) return 0;

    const firstArg = args[0]!;
    if (!Node.isStringLiteral(firstArg)) return 0;

    const specifier = firstArg.getLiteralValue();
    if (!isSdkSpecifier(specifier)) return 0;

    const factorySymbols = args.length >= 2 ? collectFactorySymbols(args[1]!) : [];
    const resolved = resolveTarget(specifier, context, sourceFile, factorySymbols, {
        filePath: sourceFile.getFilePath(),
        line: call.getStartLineNumber(),
        diagnostics
    });
    if (resolved === null) {
        diagnostics.push(actionRequired(sourceFile.getFilePath(), call, `Unknown SDK mock path: ${specifier}. Manual migration required.`));
        return 0;
    }
    if ('removed' in resolved) {
        const diagFn = resolved.isV2Gap ? v2Gap : warning;
        diagnostics.push(
            diagFn(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                resolved.removalMessage ?? `Mock references removed SDK path: ${specifier}. Manual migration required.`
            )
        );
        return 0;
    }

    let changes = 0;

    let effectiveTarget = resolved.target;
    if (args.length >= 2) {
        // Route the factory's mocked symbols the same way the static import transform would: a factory of
        // only `*Schema` constants (from sdk/types.js or sdk/shared/auth.js) moves to core; a factory
        // of only `StreamableHTTPServerTransport` moves to @modelcontextprotocol/node. A single mock path
        // can't be split, so a mix of packages is flagged for manual migration.
        const { target: routedTarget, mixed } = routeSymbols(factorySymbols, resolved.mapping);
        if (routedTarget) {
            effectiveTarget = routedTarget;
        } else if (mixed) {
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    call,
                    `Mock factory from ${specifier} mixes symbols that belong to different v2 packages. ` +
                        `Split the mock manually so each symbol targets the correct package.`
                )
            );
        }
    }

    usedPackages.add(effectiveTarget);
    firstArg.setLiteralValue(effectiveTarget);
    changes++;

    const allRenames: Record<string, string> = { ...SIMPLE_RENAMES, ...resolved.mapping.renamedSymbols };
    if (args.length >= 2) {
        changes += renameSymbolsInFactory(args[1]!, allRenames);
    }

    return changes;
}

function getTopLevelObjectLiteral(factoryArg: import('ts-morph').Node): import('ts-morph').ObjectLiteralExpression | undefined {
    if (Node.isObjectLiteralExpression(factoryArg)) return factoryArg;

    if (Node.isArrowFunction(factoryArg) || Node.isFunctionExpression(factoryArg)) {
        const body = factoryArg.getBody();
        if (Node.isObjectLiteralExpression(body)) return body;
        if (Node.isParenthesizedExpression(body)) {
            const inner = body.getExpression();
            if (Node.isObjectLiteralExpression(inner)) return inner;
        }
        if (Node.isBlock(body)) {
            for (const stmt of body.getStatements()) {
                if (Node.isReturnStatement(stmt)) {
                    const expr = stmt.getExpression();
                    if (expr && Node.isObjectLiteralExpression(expr)) return expr;
                }
            }
        }
    }

    return undefined;
}

function collectFactorySymbols(factoryArg: import('ts-morph').Node): string[] {
    const obj = getTopLevelObjectLiteral(factoryArg);
    if (!obj) return [];

    const symbols: string[] = [];
    for (const prop of obj.getProperties()) {
        if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop)) {
            symbols.push(prop.getName());
        }
    }
    return symbols;
}

function renameSymbolsInFactory(factoryArg: import('ts-morph').Node, renamedSymbols: Record<string, string>): number {
    const obj = getTopLevelObjectLiteral(factoryArg);
    if (!obj) return 0;

    let changes = 0;
    for (const prop of obj.getProperties()) {
        if (Node.isPropertyAssignment(prop)) {
            const name = prop.getName();
            const newName = renamedSymbols[name];
            if (newName) {
                prop.getNameNode().replaceWithText(newName);
                changes++;
            }
        }

        if (Node.isShorthandPropertyAssignment(prop)) {
            const name = prop.getName();
            const newName = renamedSymbols[name];
            if (newName) {
                prop.replaceWithText(`${newName}: ${name}`);
                changes++;
            }
        }
    }

    return changes;
}

/**
 * The destructured binding keys of an `await import()` assigned to an object binding pattern (e.g.
 * `const { CallToolResultSchema, McpError } = await import('…')`), or `[]` for a non-destructured
 * binding, a `.then()` chain, or an unassigned `await import()`. The keys feed per-symbol routing —
 * the specifier itself can't be split.
 */
function getDestructuredKeys(node: import('ts-morph').CallExpression): string[] {
    const parent = node.getParent();
    if (!parent || !Node.isAwaitExpression(parent)) return [];
    const grandParent = parent.getParent();
    if (!grandParent || !Node.isVariableDeclaration(grandParent)) return [];
    const nameNode = grandParent.getNameNode();
    if (!Node.isObjectBindingPattern(nameNode)) return [];
    return nameNode.getElements().map(el => el.getPropertyNameNode()?.getText() ?? el.getName());
}

/**
 * For a dynamic import whose module binding is NOT a destructurable object pattern — a non-destructured
 * `const mod = await import('…')` or a `.then(m => …)` chain — collect the Zod schema constants
 * accessed off that binding (e.g. `mod.OAuthTokensSchema`). The destructured form is routed/renamed
 * elsewhere; these forms can't be split per-symbol, so the schema accesses are surfaced as a diagnostic
 * (mirroring the namespace-import branch of the static import transform — see `importPaths.ts`). Returns
 * deduped `[v1Name, v2Name]` pairs (a schema may be renamed, e.g. JSONRPCResponseSchema →
 * JSONRPCResultResponseSchema, and core only exports the v2 name). Empty unless the mapping carries a
 * `schemaSymbolTarget`.
 */
function collectModuleSchemaAccesses(
    node: import('ts-morph').CallExpression,
    mapping: ImportMapping,
    sourceFile: SourceFile
): Array<readonly [string, string]> {
    if (!mapping.schemaSymbolTarget) return [];

    let bindingName: string | undefined;
    let scope: import('ts-morph').Node | undefined;

    const parent = node.getParent();
    if (parent && Node.isAwaitExpression(parent)) {
        // const mod = await import('…')  → `mod` is in scope for the rest of the file.
        const grandParent = parent.getParent();
        if (grandParent && Node.isVariableDeclaration(grandParent)) {
            const nameNode = grandParent.getNameNode();
            if (Node.isIdentifier(nameNode)) {
                bindingName = nameNode.getText();
                scope = sourceFile;
            }
        }
    } else if (parent && Node.isPropertyAccessExpression(parent) && parent.getName() === 'then') {
        // import('…').then(m => m.XxxSchema…)  → the module is the `.then` callback's first parameter.
        const thenCall = parent.getParent();
        if (thenCall && Node.isCallExpression(thenCall)) {
            const cb = thenCall.getArguments()[0];
            if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
                const paramName = cb.getParameters()[0]?.getNameNode();
                if (paramName && Node.isIdentifier(paramName)) {
                    bindingName = paramName.getText();
                    scope = cb;
                }
            }
        }
    }

    if (!bindingName || !scope) return [];

    return [
        ...new Map(
            scope
                .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
                .filter(pa => pa.getExpression().getText() === bindingName && isSharedSchemaConst(pa.getName(), mapping))
                .map(pa => [pa.getName(), resolveRenamedName(pa.getName(), mapping)] as const)
        )
    ];
}

function rewriteDynamicImports(
    sourceFile: SourceFile,
    context: TransformContext,
    diagnostics: Diagnostic[],
    usedPackages: Set<string>
): number {
    let changes = 0;

    sourceFile.forEachDescendant(node => {
        if (!Node.isCallExpression(node)) return;

        const expr = node.getExpression();
        if (expr.getKind() !== SyntaxKind.ImportKeyword) return;

        const args = node.getArguments();
        if (args.length === 0) return;

        const firstArg = args[0]!;
        if (!Node.isStringLiteral(firstArg)) return;

        const specifier = firstArg.getLiteralValue();
        if (!isSdkSpecifier(specifier)) return;

        const destructuredKeys = getDestructuredKeys(node);
        const resolved = resolveTarget(specifier, context, sourceFile, destructuredKeys, {
            filePath: sourceFile.getFilePath(),
            line: node.getStartLineNumber(),
            diagnostics
        });
        if (resolved === null) {
            diagnostics.push(
                actionRequired(sourceFile.getFilePath(), node, `Unknown SDK dynamic import path: ${specifier}. Manual migration required.`)
            );
            return;
        }
        if ('removed' in resolved) {
            const diagFn = resolved.isV2Gap ? v2Gap : warning;
            diagnostics.push(
                diagFn(
                    sourceFile.getFilePath(),
                    node.getStartLineNumber(),
                    resolved.removalMessage ?? `Dynamic import references removed SDK path: ${specifier}. Manual migration required.`
                )
            );
            return;
        }

        let effectiveTarget = resolved.target;
        const allRenames: Record<string, string> = { ...SIMPLE_RENAMES, ...resolved.mapping.renamedSymbols };

        // Route the destructured bindings the same way the static import transform would: a destructuring
        // of only `*Schema` constants (e.g. `const { CallToolResultSchema } = await import('…/types.js')`)
        // moves to core, and `StreamableHTTPServerTransport` moves to @modelcontextprotocol/node. A
        // single import() specifier can't be split, so a mix of packages is flagged for manual migration.
        const { target: routedTarget, mixed } = routeSymbols(destructuredKeys, resolved.mapping);
        if (routedTarget) {
            effectiveTarget = routedTarget;
        } else if (mixed) {
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    node,
                    `Dynamic import of ${specifier} destructures symbols that belong to different v2 packages. ` +
                        `Split the import manually so each symbol targets the correct package.`
                )
            );
        }

        // A non-destructured binding (`const mod = await import('…')`) or a `.then(m => …)` chain can't be
        // routed per-symbol, so the specifier moves to the context package — which does NOT export the
        // Zod `*Schema` constants (those live in `schemaSymbolTarget`/core). Any `mod.<Name>Schema` /
        // `m.<Name>Schema` accesses would silently break, so flag them (mirroring the namespace-import
        // branch of the static import transform). The destructured form is handled by `routeSymbols` above.
        const schemaAccesses = collectModuleSchemaAccesses(node, resolved.mapping, sourceFile);
        if (schemaAccesses.length > 0) {
            const accessed = schemaAccesses.map(([v1]) => v1).join(', ');
            const importName = schemaAccesses[0]![1];
            const renamed = schemaAccesses.filter(([v1, v2]) => v1 !== v2);
            const renameNote = renamed.length > 0 ? ` Renamed in v2: ${renamed.map(([v1, v2]) => `${v1} → ${v2}`).join(', ')}.` : '';
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    node,
                    `Dynamic import of ${specifier} is used to access Zod schema(s) (${accessed}) that moved to ${resolved.mapping.schemaSymbolTarget}.${renameNote} ` +
                        `Import them with a named import (e.g. \`import { ${importName} } from '${resolved.mapping.schemaSymbolTarget}'\`) and update the qualified usages.`
                )
            );
        }

        usedPackages.add(effectiveTarget);
        firstArg.setLiteralValue(effectiveTarget);
        changes++;

        const parent = node.getParent();
        if (parent && Node.isAwaitExpression(parent)) {
            const grandParent = parent.getParent();
            if (grandParent && Node.isVariableDeclaration(grandParent)) {
                const nameNode = grandParent.getNameNode();
                if (Node.isObjectBindingPattern(nameNode)) {
                    for (const element of nameNode.getElements()) {
                        const propertyName = element.getPropertyNameNode()?.getText();
                        const bindingName = element.getName();
                        const lookupKey = propertyName ?? bindingName;
                        const newName = allRenames[lookupKey];
                        if (newName) {
                            if (propertyName) {
                                element.getPropertyNameNode()!.replaceWithText(newName);
                            } else {
                                element.replaceWithText(`${newName}: ${bindingName}`);
                            }
                            changes++;
                        }
                    }
                }
                const moduleRenames = resolved.mapping.renamedSymbols ?? {};
                if (!Node.isObjectBindingPattern(nameNode) && Object.keys(moduleRenames).length > 0) {
                    diagnostics.push(
                        actionRequired(
                            sourceFile.getFilePath(),
                            node,
                            `Dynamic import assigned to variable (not destructured). Symbol renames (${Object.keys(moduleRenames).join(', ')}) were not applied. Manual update may be needed.`
                        )
                    );
                }
            }
        }
    });

    return changes;
}
