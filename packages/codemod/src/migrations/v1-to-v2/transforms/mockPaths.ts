import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { v2Gap, warning } from '../../../utils/diagnostics.js';
import { isSdkSpecifier } from '../../../utils/importUtils.js';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer.js';
import { IMPORT_MAP, isAuthImport } from '../mappings/importMap.js';
import { SIMPLE_RENAMES } from '../mappings/symbolMap.js';

const MOCK_METHODS = new Set(['mock', 'doMock']);
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
    diagnosticSink?: { filePath: string; line: number; diagnostics: Diagnostic[] }
):
    | { target: string; renamedSymbols?: Record<string, string>; symbolTargetOverrides?: Record<string, string> }
    | { removed: true; isV2Gap?: boolean; removalMessage?: string }
    | null {
    const mapping = IMPORT_MAP[specifier];
    if (!mapping && isAuthImport(specifier)) return { removed: true };
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
        target = resolveTypesPackage(context, hasClient, hasServer, diagnosticSink);
    }

    return { target, renamedSymbols: mapping.renamedSymbols, symbolTargetOverrides: mapping.symbolTargetOverrides };
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

    const resolved = resolveTarget(specifier, context, sourceFile, {
        filePath: sourceFile.getFilePath(),
        line: call.getStartLineNumber(),
        diagnostics
    });
    if (resolved === null) {
        diagnostics.push(
            warning(sourceFile.getFilePath(), call.getStartLineNumber(), `Unknown SDK mock path: ${specifier}. Manual migration required.`)
        );
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
    if (resolved.symbolTargetOverrides && args.length >= 2) {
        const factorySymbols = collectFactorySymbols(args[1]!);
        const allOverridden = factorySymbols.length > 0 && factorySymbols.every(s => s in resolved.symbolTargetOverrides!);
        const someOverridden = factorySymbols.some(s => s in resolved.symbolTargetOverrides!);
        if (allOverridden) {
            effectiveTarget = resolved.symbolTargetOverrides[factorySymbols[0]!]!;
        } else if (someOverridden) {
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    call.getStartLineNumber(),
                    `Mock factory from ${specifier} mixes symbols that belong to different v2 packages. ` +
                        `Split the mock manually so each symbol targets the correct package.`
                )
            );
        }
    }

    usedPackages.add(effectiveTarget);
    firstArg.setLiteralValue(effectiveTarget);
    changes++;

    const allRenames: Record<string, string> = { ...SIMPLE_RENAMES, ...resolved.renamedSymbols };
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

        const resolved = resolveTarget(specifier, context, sourceFile, {
            filePath: sourceFile.getFilePath(),
            line: node.getStartLineNumber(),
            diagnostics
        });
        if (resolved === null) {
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    node.getStartLineNumber(),
                    `Unknown SDK dynamic import path: ${specifier}. Manual migration required.`
                )
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
        const allRenames: Record<string, string> = { ...SIMPLE_RENAMES, ...resolved.renamedSymbols };

        // Check if destructured symbols should route to an override target
        if (resolved.symbolTargetOverrides) {
            const parent = node.getParent();
            if (parent && Node.isAwaitExpression(parent)) {
                const grandParent = parent.getParent();
                if (grandParent && Node.isVariableDeclaration(grandParent)) {
                    const nameNode = grandParent.getNameNode();
                    if (Node.isObjectBindingPattern(nameNode)) {
                        const elements = nameNode.getElements();
                        const allOverridden =
                            elements.length > 0 &&
                            elements.every(el => {
                                const key = el.getPropertyNameNode()?.getText() ?? el.getName();
                                return key in resolved.symbolTargetOverrides!;
                            });
                        if (allOverridden) {
                            effectiveTarget =
                                resolved.symbolTargetOverrides[elements[0]!.getPropertyNameNode()?.getText() ?? elements[0]!.getName()]!;
                        }
                    }
                }
            }
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
                const moduleRenames = resolved.renamedSymbols ?? {};
                if (!Node.isObjectBindingPattern(nameNode) && Object.keys(moduleRenames).length > 0) {
                    diagnostics.push(
                        warning(
                            sourceFile.getFilePath(),
                            node.getStartLineNumber(),
                            `Dynamic import assigned to variable (not destructured). Symbol renames (${Object.keys(moduleRenames).join(', ')}) were not applied. Manual update may be needed.`
                        )
                    );
                }
            }
        }
    });

    return changes;
}
