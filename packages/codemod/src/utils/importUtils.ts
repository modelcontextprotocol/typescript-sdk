import type { ExportDeclaration, ImportDeclaration, SourceFile } from 'ts-morph';
import { Node } from 'ts-morph';

const SDK_PREFIX = '@modelcontextprotocol/sdk';

const V2_PACKAGES = new Set([
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/core-internal',
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

/** A named import to emit: either a bare name, or a `{ name, alias }` pair preserving an `as` alias. */
export type NamedImportSpec = string | { name: string; alias?: string };

function toSpec(n: NamedImportSpec): { name: string; alias?: string } {
    return typeof n === 'string' ? { name: n } : n;
}

/** Local binding a spec introduces — the alias when present, otherwise the imported name. */
function specLocalName(s: { name: string; alias?: string }): string {
    return s.alias ?? s.name;
}

export function addOrMergeImport(
    sourceFile: SourceFile,
    moduleSpecifier: string,
    namedImports: NamedImportSpec[],
    isTypeOnly: boolean,
    insertIndex: number
): void {
    if (namedImports.length === 0) return;

    const specs = namedImports.map(n => toSpec(n));

    const existing = sourceFile.getImportDeclarations().find(imp => {
        if (imp.getNamespaceImport()) return false;
        return imp.getModuleSpecifierValue() === moduleSpecifier && imp.isTypeOnly() === isTypeOnly;
    });

    if (existing) {
        const existingLocals = new Set(existing.getNamedImports().map(n => n.getAliasNode()?.getText() ?? n.getName()));
        const newSpecs = specs.filter(s => !existingLocals.has(specLocalName(s)));
        if (newSpecs.length > 0) {
            existing.addNamedImports(newSpecs.map(s => (s.alias ? { name: s.name, alias: s.alias } : { name: s.name })));
        }
    } else {
        const seen = new Set<string>();
        const deduped = specs.filter(s => {
            const local = specLocalName(s);
            if (seen.has(local)) return false;
            seen.add(local);
            return true;
        });
        const clampedIndex = Math.min(insertIndex, sourceFile.getImportDeclarations().length);
        sourceFile.insertImportDeclaration(clampedIndex, {
            moduleSpecifier,
            namedImports: deduped.map(s => (s.alias ? { name: s.name, alias: s.alias } : { name: s.name })),
            isTypeOnly
        });
    }
}

/** True when the specifier resolves to one of the published v2 packages (root or subpath). */
export function isV2Specifier(specifier: string): boolean {
    if (V2_PACKAGES.has(specifier)) return true;
    const secondSlash = specifier.indexOf('/', specifier.indexOf('/') + 1);
    return secondSlash !== -1 && V2_PACKAGES.has(specifier.slice(0, secondSlash));
}

export function isAnyMcpSpecifier(specifier: string): boolean {
    if (isSdkSpecifier(specifier)) return true;
    if (V2_PACKAGES.has(specifier)) return true;
    const secondSlash = specifier.indexOf('/', specifier.indexOf('/') + 1);
    return secondSlash !== -1 && V2_PACKAGES.has(specifier.slice(0, secondSlash));
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
