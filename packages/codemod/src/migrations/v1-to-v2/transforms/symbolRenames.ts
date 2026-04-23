import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { renameAllReferences } from '../../../utils/astUtils.js';
import { info, warning } from '../../../utils/diagnostics.js';
import { addOrMergeImport, isAnyMcpSpecifier } from '../../../utils/importUtils.js';
import { resolveTypesPackage } from '../../../utils/projectAnalyzer.js';
import { ERROR_CODE_SDK_MEMBERS, SIMPLE_RENAMES } from '../mappings/symbolMap.js';

const SERVER_GENERIC_ARGS = new Set(['ServerRequest', 'ServerNotification']);
const CLIENT_GENERIC_ARGS = new Set(['ClientRequest', 'ClientNotification']);

export const symbolRenamesTransform: Transform = {
    name: 'Symbol renames',
    id: 'symbols',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        const imports = sourceFile.getImportDeclarations();

        for (const imp of imports) {
            for (const namedImport of imp.getNamedImports()) {
                const name = namedImport.getName();
                const newName = SIMPLE_RENAMES[name];
                if (newName) {
                    namedImport.setName(newName);
                    const alias = namedImport.getAliasNode();
                    if (!alias) {
                        renameAllReferences(sourceFile, name, newName);
                    }
                    changesCount++;
                }
            }
        }

        changesCount += handleErrorCodeSplit(sourceFile, diagnostics);
        changesCount += handleRequestHandlerExtra(sourceFile, context, diagnostics);
        changesCount += handleSchemaInput(sourceFile, context, diagnostics);

        return { changesCount, diagnostics };
    }
};

function handleErrorCodeSplit(sourceFile: SourceFile, diagnostics: ReturnType<typeof warning>[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let errorCodeImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;

    for (const imp of imports) {
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'ErrorCode') {
                errorCodeImport = namedImport;
                break;
            }
        }
        if (errorCodeImport) break;
    }

    if (!errorCodeImport) return 0;

    let needsProtocolErrorCode = false;
    let needsSdkErrorCode = false;

    sourceFile.forEachDescendant(node => {
        if (!Node.isPropertyAccessExpression(node)) return;
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== 'ErrorCode') return;

        const member = node.getName();
        if (ERROR_CODE_SDK_MEMBERS.has(member)) {
            needsSdkErrorCode = true;
            node.getExpression().replaceWithText('SdkErrorCode');
        } else {
            needsProtocolErrorCode = true;
            node.getExpression().replaceWithText('ProtocolErrorCode');
        }
        changesCount++;
    });

    if (changesCount > 0) {
        errorCodeImport.remove();

        const imp = sourceFile.getImportDeclarations().find(i => {
            const spec = i.getModuleSpecifierValue();
            return spec === '@modelcontextprotocol/client' || spec === '@modelcontextprotocol/server';
        });
        const targetModule = imp?.getModuleSpecifierValue() ?? '@modelcontextprotocol/server';

        const newImports: string[] = [];
        if (needsProtocolErrorCode) newImports.push('ProtocolErrorCode');
        if (needsSdkErrorCode) newImports.push('SdkErrorCode');

        if (newImports.length > 0) {
            const existingImp = sourceFile
                .getImportDeclarations()
                .find(i => i.getModuleSpecifierValue() === targetModule && !i.isTypeOnly());
            if (existingImp) {
                const existingNames = new Set(existingImp.getNamedImports().map(n => n.getName()));
                const toAdd = newImports.filter(n => !existingNames.has(n));
                if (toAdd.length > 0) {
                    existingImp.addNamedImports(toAdd);
                }
            } else {
                sourceFile.addImportDeclaration({
                    moduleSpecifier: targetModule,
                    namedImports: newImports
                });
            }
        }

        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                1,
                'ErrorCode split into ProtocolErrorCode and SdkErrorCode. Verify the migration is correct.'
            )
        );
    }

    return changesCount;
}

function handleRequestHandlerExtra(sourceFile: SourceFile, context: TransformContext, diagnostics: ReturnType<typeof warning>[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let extraImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;
    let extraImportDecl: (typeof imports)[0] | undefined;

    for (const imp of imports) {
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'RequestHandlerExtra') {
                extraImport = namedImport;
                extraImportDecl = imp;
                break;
            }
        }
        if (extraImport) break;
    }

    if (!extraImport) return 0;

    const isClientFile = sourceFile.getImportDeclarations().some(i => {
        const spec = i.getModuleSpecifierValue();
        return spec.includes('/client/') || spec === '@modelcontextprotocol/client';
    });
    const isServerFile = sourceFile.getImportDeclarations().some(i => {
        const spec = i.getModuleSpecifierValue();
        return spec.includes('/server/') || spec === '@modelcontextprotocol/server';
    });

    let defaultTarget: 'ServerContext' | 'ClientContext' = 'ServerContext';
    if (isClientFile && !isServerFile) {
        defaultTarget = 'ClientContext';
    } else if (context.projectType === 'client') {
        defaultTarget = 'ClientContext';
    }

    let needsServerContext = false;
    let needsClientContext = false;

    sourceFile.forEachDescendant(node => {
        if (!Node.isTypeReference(node)) return;
        const typeName = node.getTypeName();
        if (!Node.isIdentifier(typeName) || typeName.getText() !== 'RequestHandlerExtra') return;

        let target = defaultTarget;
        const typeArgs = node.getTypeArguments();
        if (typeArgs.length > 0) {
            const firstArgText = typeArgs[0]!.getText();
            if (SERVER_GENERIC_ARGS.has(firstArgText)) {
                target = 'ServerContext';
            } else if (CLIENT_GENERIC_ARGS.has(firstArgText)) {
                target = 'ClientContext';
            }
        }

        if (target === 'ServerContext') needsServerContext = true;
        if (target === 'ClientContext') needsClientContext = true;

        if (typeArgs.length > 0) {
            node.replaceWithText(target);
        } else {
            typeName.replaceWithText(target);
        }
        changesCount++;
    });

    if (changesCount > 0) {
        extraImport.remove();

        const newImports: Array<{ name: string; target: string }> = [];
        if (needsServerContext) newImports.push({ name: 'ServerContext', target: '@modelcontextprotocol/server' });
        if (needsClientContext) newImports.push({ name: 'ClientContext', target: '@modelcontextprotocol/client' });

        for (const { name, target } of newImports) {
            const existingImp = sourceFile
                .getImportDeclarations()
                .find(i => i.getModuleSpecifierValue() === target && i.isTypeOnly());
            if (existingImp) {
                const existingNames = new Set(existingImp.getNamedImports().map(n => n.getName()));
                if (!existingNames.has(name)) {
                    existingImp.addNamedImports([name]);
                }
            } else {
                const valueImp = sourceFile
                    .getImportDeclarations()
                    .find(i => i.getModuleSpecifierValue() === target && !i.isTypeOnly());
                if (valueImp) {
                    const existingNames = new Set(valueImp.getNamedImports().map(n => n.getName()));
                    if (!existingNames.has(name)) {
                        valueImp.addNamedImports([name]);
                    }
                } else {
                    sourceFile.addImportDeclaration({
                        isTypeOnly: true,
                        moduleSpecifier: target,
                        namedImports: [name]
                    });
                }
            }
        }

        changesCount++;

        const targets = newImports.map(i => i.name).join(' and ');
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                extraImportDecl!.getStartLineNumber(),
                `RequestHandlerExtra renamed to ${targets}. Generic type arguments removed. Verify the migration is correct.`
            )
        );
    }

    return changesCount;
}

function handleSchemaInput(sourceFile: SourceFile, context: TransformContext, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const imports = sourceFile.getImportDeclarations();
    let schemaInputImport: ReturnType<(typeof imports)[0]['getNamedImports']>[0] | undefined;
    let schemaInputImportDecl: (typeof imports)[0] | undefined;

    for (const imp of imports) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const namedImport of imp.getNamedImports()) {
            if (namedImport.getName() === 'SchemaInput') {
                schemaInputImport = namedImport;
                schemaInputImportDecl = imp;
                break;
            }
        }
        if (schemaInputImport) break;
    }

    if (!schemaInputImport || !schemaInputImportDecl) return 0;

    sourceFile.forEachDescendant(node => {
        if (!Node.isTypeReference(node)) return;
        const typeName = node.getTypeName();
        if (!Node.isIdentifier(typeName) || typeName.getText() !== 'SchemaInput') return;

        const typeArgs = node.getTypeArguments();
        if (typeArgs.length > 0) {
            const argText = typeArgs[0]!.getText();
            node.replaceWithText(`StandardSchemaWithJSON.InferInput<${argText}>`);
        } else {
            node.replaceWithText('StandardSchemaWithJSON.InferInput<unknown>');
        }
        changesCount++;
    });

    if (changesCount > 0) {
        schemaInputImport.remove();
        if (
            schemaInputImportDecl.getNamedImports().length === 0 &&
            !schemaInputImportDecl.getDefaultImport() &&
            !schemaInputImportDecl.getNamespaceImport()
        ) {
            schemaInputImportDecl.remove();
        }

        const isClientFile = sourceFile.getImportDeclarations().some(i => {
            const spec = i.getModuleSpecifierValue();
            return spec.includes('/client') || spec === '@modelcontextprotocol/client';
        });
        const isServerFile = sourceFile.getImportDeclarations().some(i => {
            const spec = i.getModuleSpecifierValue();
            return spec.includes('/server') || spec === '@modelcontextprotocol/server';
        });
        const targetModule = resolveTypesPackage(context, isClientFile, isServerFile);

        const insertIndex = sourceFile.getImportDeclarations().length;
        addOrMergeImport(sourceFile, targetModule, ['StandardSchemaWithJSON'], true, insertIndex);
        changesCount++;

        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                1,
                'SchemaInput<T> replaced with StandardSchemaWithJSON.InferInput<T>. Verify the migration is correct.'
            )
        );
    }

    return changesCount;
}
