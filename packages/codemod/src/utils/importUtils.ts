import type { ExportDeclaration, ImportDeclaration, SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

const SDK_PREFIX = '@modelcontextprotocol/sdk';

const V2_PACKAGES = new Set([
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/core',
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/express'
]);

export function isSdkSpecifier(specifier: string): boolean {
    return specifier === SDK_PREFIX || specifier.startsWith(SDK_PREFIX + '/');
}

export function getSdkImports(sourceFile: SourceFile): ImportDeclaration[] {
    return sourceFile.getImportDeclarations().filter(imp => {
        return isSdkSpecifier(imp.getModuleSpecifierValue());
    });
}

export function getSdkExports(sourceFile: SourceFile): ExportDeclaration[] {
    return sourceFile.getExportDeclarations().filter(exp => {
        const specifier = exp.getModuleSpecifierValue();
        return specifier != null && isSdkSpecifier(specifier);
    });
}

export function isTypeOnlyImport(imp: ImportDeclaration): boolean {
    return imp.isTypeOnly();
}

export function addOrMergeImport(
    sourceFile: SourceFile,
    moduleSpecifier: string,
    namedImports: string[],
    isTypeOnly: boolean,
    insertIndex: number
): void {
    if (namedImports.length === 0) return;

    const existing = sourceFile.getImportDeclarations().find(imp => {
        return imp.getModuleSpecifierValue() === moduleSpecifier && imp.isTypeOnly() === isTypeOnly;
    });

    if (existing) {
        const existingNames = new Set(existing.getNamedImports().map(n => n.getName()));
        const newNames = namedImports.filter(n => !existingNames.has(n));
        if (newNames.length > 0) {
            existing.addNamedImports(newNames);
        }
    } else {
        const clampedIndex = Math.min(insertIndex, sourceFile.getImportDeclarations().length);
        sourceFile.insertImportDeclaration(clampedIndex, {
            moduleSpecifier,
            namedImports: [...new Set(namedImports)],
            isTypeOnly
        });
    }
}

export function isAnyMcpSpecifier(specifier: string): boolean {
    return isSdkSpecifier(specifier) || V2_PACKAGES.has(specifier);
}

export function hasMcpImports(sourceFile: SourceFile): boolean {
    return sourceFile.getImportDeclarations().some(imp => isAnyMcpSpecifier(imp.getModuleSpecifierValue()));
}

export function isImportedFromMcp(sourceFile: SourceFile, symbolName: string): boolean {
    return sourceFile.getImportDeclarations().some(imp => {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) return false;
        return imp.getNamedImports().some(n => {
            const localName = n.getAliasNode()?.getText() ?? n.getName();
            return localName === symbolName;
        });
    });
}

export function isOriginalNameImportedFromMcp(sourceFile: SourceFile, exportName: string): boolean {
    return sourceFile.getImportDeclarations().some(imp => {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) return false;
        return imp.getNamedImports().some(n => n.getName() === exportName);
    });
}

export function resolveLocalImportName(sourceFile: SourceFile, exportName: string): string | undefined {
    for (const imp of sourceFile.getImportDeclarations()) {
        if (!isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
        for (const n of imp.getNamedImports()) {
            if (n.getName() === exportName) {
                return n.getAliasNode()?.getText() ?? exportName;
            }
        }
    }
    return undefined;
}

export function resolveOriginalImportName(sourceFile: SourceFile, localName: string): string | undefined {
    for (const imp of sourceFile.getImportDeclarations()) {
        for (const n of imp.getNamedImports()) {
            const alias = n.getAliasNode()?.getText();
            if (alias === localName) return n.getName();
            if (!alias && n.getName() === localName) return localName;
        }
    }
    return undefined;
}

export function removeUnusedImport(sourceFile: SourceFile, symbolName: string, onlyMcpImports?: boolean): void {
    let referenceCount = 0;
    sourceFile.forEachDescendant(node => {
        if (Node.isIdentifier(node) && node.getText() === symbolName) {
            const parent = node.getParent();
            if (parent && !Node.isImportSpecifier(parent)) {
                referenceCount++;
            }
        }
    });

    if (referenceCount === 0) {
        for (const imp of sourceFile.getImportDeclarations()) {
            if (onlyMcpImports && !isAnyMcpSpecifier(imp.getModuleSpecifierValue())) continue;
            for (const namedImport of imp.getNamedImports()) {
                if ((namedImport.getAliasNode()?.getText() ?? namedImport.getName()) === symbolName) {
                    namedImport.remove();
                    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
                        imp.remove();
                    }
                    return;
                }
            }
        }
    }
}
