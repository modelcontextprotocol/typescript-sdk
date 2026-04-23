import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types.js';
import { warning } from '../../../utils/diagnostics.js';
import { isSdkSpecifier } from '../../../utils/importUtils.js';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer.js';
import { IMPORT_MAP, isAuthImport } from '../mappings/importMap.js';

const MOCK_METHODS = new Set(['mock', 'doMock']);
const MOCK_CALLERS = new Set(['vi', 'jest']);

export const mockPathsTransform: Transform = {
    name: 'Mock and dynamic import path rewrites',
    id: 'mock-paths',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: ReturnType<typeof warning>[] = [];
        let changesCount = 0;

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const call of calls) {
            const expr = call.getExpression();

            if (Node.isPropertyAccessExpression(expr)) {
                const objName = expr.getExpression().getText();
                const methodName = expr.getName();
                if (MOCK_CALLERS.has(objName) && MOCK_METHODS.has(methodName)) {
                    changesCount += rewriteMockCall(call, sourceFile, context, diagnostics);
                }
            }

            if (Node.isImportExpression(expr) || call.getExpression().getText() === 'import') {
                continue;
            }
        }

        changesCount += rewriteDynamicImports(sourceFile, context, diagnostics);

        return { changesCount, diagnostics };
    }
};

function resolveTarget(
    specifier: string,
    context: TransformContext,
    sourceFile: SourceFile
): { target: string; renamedSymbols?: Record<string, string> } | 'removed' | null {
    const mapping = IMPORT_MAP[specifier];
    if (!mapping && isAuthImport(specifier)) return 'removed';
    if (!mapping) return null;
    if (mapping.status === 'removed') return 'removed';

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
        target = resolveTypesPackage(context, hasClient, hasServer);
    }

    return { target, renamedSymbols: mapping.renamedSymbols };
}

function rewriteMockCall(
    call: import('ts-morph').CallExpression,
    sourceFile: SourceFile,
    context: TransformContext,
    diagnostics: ReturnType<typeof warning>[]
): number {
    const args = call.getArguments();
    if (args.length === 0) return 0;

    const firstArg = args[0]!;
    if (!Node.isStringLiteral(firstArg)) return 0;

    const specifier = firstArg.getLiteralValue();
    if (!isSdkSpecifier(specifier)) return 0;

    const resolved = resolveTarget(specifier, context, sourceFile);
    if (resolved === null) {
        diagnostics.push(
            warning(sourceFile.getFilePath(), call.getStartLineNumber(), `Unknown SDK mock path: ${specifier}. Manual migration required.`)
        );
        return 0;
    }
    if (resolved === 'removed') {
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                `Mock references removed SDK path: ${specifier}. Manual migration required.`
            )
        );
        return 0;
    }

    let changes = 0;

    firstArg.setLiteralValue(resolved.target);
    changes++;

    if (resolved.renamedSymbols && args.length >= 2) {
        changes += renameSymbolsInFactory(args[1]!, resolved.renamedSymbols);
    }

    return changes;
}

function renameSymbolsInFactory(factoryArg: import('ts-morph').Node, renamedSymbols: Record<string, string>): number {
    let changes = 0;

    factoryArg.forEachDescendant(node => {
        if (Node.isPropertyAssignment(node)) {
            const name = node.getName();
            const newName = renamedSymbols[name];
            if (newName) {
                node.getNameNode().replaceWithText(newName);
                changes++;
            }
        }

        if (Node.isShorthandPropertyAssignment(node)) {
            const name = node.getName();
            const newName = renamedSymbols[name];
            if (newName) {
                node.replaceWithText(`${newName}: ${name}`);
                changes++;
            }
        }
    });

    return changes;
}

function rewriteDynamicImports(sourceFile: SourceFile, context: TransformContext, _diagnostics: ReturnType<typeof warning>[]): number {
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

        const resolved = resolveTarget(specifier, context, sourceFile);
        if (resolved === null || resolved === 'removed') return;

        firstArg.setLiteralValue(resolved.target);
        changes++;

        if (resolved.renamedSymbols) {
            const parent = node.getParent();
            if (parent && Node.isAwaitExpression(parent)) {
                const grandParent = parent.getParent();
                if (grandParent && Node.isVariableDeclaration(grandParent)) {
                    const nameNode = grandParent.getNameNode();
                    if (Node.isObjectBindingPattern(nameNode)) {
                        for (const element of nameNode.getElements()) {
                            const bindingName = element.getName();
                            const newName = resolved.renamedSymbols[bindingName];
                            if (newName) {
                                element.getNameNode().replaceWithText(newName);
                                changes++;
                            }
                        }
                    }
                }
            }
        }
    });

    return changes;
}
