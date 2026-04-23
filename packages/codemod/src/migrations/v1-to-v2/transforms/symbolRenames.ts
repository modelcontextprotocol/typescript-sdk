import type { SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types.js';
import { warning } from '../../../utils/diagnostics.js';
import { ERROR_CODE_SDK_MEMBERS, SIMPLE_RENAMES } from '../mappings/symbolMap.js';

const SERVER_GENERIC_ARGS = new Set(['ServerRequest', 'ServerNotification']);
const CLIENT_GENERIC_ARGS = new Set(['ClientRequest', 'ClientNotification']);

export const symbolRenamesTransform: Transform = {
    name: 'Symbol renames',
    id: 'symbols',
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult {
        const diagnostics: ReturnType<typeof warning>[] = [];
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

        return { changesCount, diagnostics };
    }
};

function renameAllReferences(sourceFile: SourceFile, oldName: string, newName: string): void {
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node) && node.getText() === oldName) {
            const parent = node.getParent();
            if (!parent) return;
            if (Node.isImportSpecifier(parent)) return;
            if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return;
            if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return;
            if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return;
            node.replaceWithText(newName);
        }
    });
}

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

        if (typeArgs.length > 0) {
            node.replaceWithText(target);
        } else {
            typeName.replaceWithText(target);
        }
        changesCount++;
    });

    if (changesCount > 0) {
        extraImport.setName(defaultTarget);
        changesCount++;

        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                extraImportDecl!.getStartLineNumber(),
                `RequestHandlerExtra renamed to ${defaultTarget}. Generic type arguments removed. Verify the migration is correct.`
            )
        );
    }

    return changesCount;
}
