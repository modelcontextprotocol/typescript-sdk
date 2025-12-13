#!/usr/bin/env npx tsx
/**
 * List all exported symbols from src/types.ts using TypeScript compiler API.
 *
 * Usage:
 *   npx tsx scripts/export-symbols.ts
 *   npx tsx scripts/export-symbols.ts --json
 */

import * as ts from 'typescript';
import * as path from 'path';

const typesPath = path.resolve(import.meta.dirname, '../src/types.ts');
const jsonOutput = process.argv.includes('--json');

// Create a program with the types file
const program = ts.createProgram([typesPath], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
});

const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(typesPath);

if (!sourceFile) {
    console.error('Could not find source file:', typesPath);
    process.exit(1);
}

interface ExportInfo {
    name: string;
    kind: string;
    isType: boolean;
}

const exports: ExportInfo[] = [];

// Get the module symbol
const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
if (moduleSymbol) {
    const exportedSymbols = checker.getExportsOfModule(moduleSymbol);

    for (const symbol of exportedSymbols) {
        const name = symbol.getName();
        const declarations = symbol.getDeclarations();

        let kind = 'unknown';
        let isType = false;

        if (declarations && declarations.length > 0) {
            const decl = declarations[0];

            if (ts.isTypeAliasDeclaration(decl)) {
                kind = 'type';
                isType = true;
            } else if (ts.isInterfaceDeclaration(decl)) {
                kind = 'interface';
                isType = true;
            } else if (ts.isClassDeclaration(decl)) {
                kind = 'class';
            } else if (ts.isFunctionDeclaration(decl)) {
                kind = 'function';
            } else if (ts.isVariableDeclaration(decl)) {
                kind = 'const';
            } else if (ts.isEnumDeclaration(decl)) {
                kind = 'enum';
            } else if (ts.isExportSpecifier(decl)) {
                // Re-exported symbol - check the original
                const originalSymbol = checker.getAliasedSymbol(symbol);
                const origDecls = originalSymbol.getDeclarations();
                if (origDecls && origDecls.length > 0) {
                    const origDecl = origDecls[0];
                    if (ts.isTypeAliasDeclaration(origDecl)) {
                        kind = 'type';
                        isType = true;
                    } else if (ts.isInterfaceDeclaration(origDecl)) {
                        kind = 'interface';
                        isType = true;
                    } else if (ts.isVariableDeclaration(origDecl)) {
                        kind = 'const';
                    } else if (ts.isEnumDeclaration(origDecl)) {
                        kind = 'enum';
                    } else if (ts.isFunctionDeclaration(origDecl)) {
                        kind = 'function';
                    }
                }
            }
        }

        exports.push({ name, kind, isType });
    }
}

// Sort by name
exports.sort((a, b) => a.name.localeCompare(b.name));

if (jsonOutput) {
    console.log(JSON.stringify(exports, null, 2));
} else {
    // Group by kind
    const byKind: Record<string, string[]> = {};
    for (const exp of exports) {
        const key = exp.kind;
        if (!byKind[key]) byKind[key] = [];
        byKind[key].push(exp.name);
    }

    console.log(`Total exports: ${exports.length}\n`);

    for (const kind of ['type', 'interface', 'const', 'enum', 'function', 'class', 'unknown']) {
        if (byKind[kind]) {
            console.log(`${kind} (${byKind[kind].length}):`);
            for (const name of byKind[kind].sort()) {
                console.log(`  ${name}`);
            }
            console.log();
        }
    }
}
