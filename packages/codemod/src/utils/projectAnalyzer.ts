import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { ts } from 'ts-morph';

import type { Diagnostic, TransformContext } from '../types';
import { info, warning } from './diagnostics';

const PROJECT_ROOT_MARKERS = ['.git', 'node_modules'];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', '.next', '.nuxt', 'coverage']);
const SCAN_FILE_BUDGET = 5000;

// Matches a quoted v1 SDK client/server subpath import specifier — e.g.
//   '@modelcontextprotocol/sdk/client/index.js'   "@modelcontextprotocol/sdk/server/mcp.js"
//   '@modelcontextprotocol/sdk/client'            (extensionless / bare subpath; see the extensionless
//                                                  import matching the codemod already supports)
// Anchored to the opening quote and a trailing `/` or closing quote so that comments or prose that
// merely mention the path do not count, and `…/client` is not confused with `…/clientfoo`.
const CLIENT_IMPORT_RE = /['"`]@modelcontextprotocol\/sdk\/client(?:\/|['"`])/;
const SERVER_IMPORT_RE = /['"`]@modelcontextprotocol\/sdk\/server(?:\/|['"`])/;

export function findPackageJson(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    while (true) {
        const candidate = path.join(dir, 'package.json');
        if (existsSync(candidate)) return candidate;
        if (dir === root) return undefined;
        if (PROJECT_ROOT_MARKERS.some(m => existsSync(path.join(dir, m)))) return undefined;
        dir = path.dirname(dir);
    }
}

const ESM_TSCONFIG_MODULES = new Set(['esnext', 'es6', 'es2015', 'es2017', 'es2020', 'es2022', 'preserve']);

function findTsconfig(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    while (true) {
        const candidate = path.join(dir, 'tsconfig.json');
        if (existsSync(candidate)) return candidate;
        if (dir === root) return undefined;
        if (PROJECT_ROOT_MARKERS.some(m => existsSync(path.join(dir, m)))) return undefined;
        dir = path.dirname(dir);
    }
}

function readPackageType(targetDir: string): string | undefined {
    const pkgJsonPath = findPackageJson(targetDir);
    if (!pkgJsonPath) return undefined;
    try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { type?: string };
        return pkg.type;
    } catch {
        return undefined;
    }
}

function readTsconfigModule(targetDir: string): string | undefined {
    const tsconfigPath = findTsconfig(targetDir);
    if (!tsconfigPath) return undefined;
    try {
        // ts.parseConfigFileTextToJson handles JSONC (comments + trailing commas). `extends` is not resolved.
        const raw = readFileSync(tsconfigPath, 'utf8');
        const parsed = ts.parseConfigFileTextToJson(tsconfigPath, raw);
        const mod = (parsed.config as { compilerOptions?: { module?: unknown } } | undefined)?.compilerOptions?.module;
        return typeof mod === 'string' ? mod.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Best-effort detection of whether the target emits ESM or CommonJS — i.e. whether a static `import` of
 * an ESM-only v2 package compiles to a native `import` (works) or a `require()` (breaks at load). Reads
 * the nearest `package.json` `"type"` and the nearest `tsconfig.json` `compilerOptions.module`. Never
 * throws: any read/parse failure falls through to the next rule, ending at `'unknown'`.
 */
export function detectModuleSystem(targetDir: string): 'esm' | 'commonjs' | 'unknown' {
    const pkgType = readPackageType(targetDir);
    if (pkgType === 'module') return 'esm';

    const tsModule = readTsconfigModule(targetDir);
    if (tsModule) {
        if (ESM_TSCONFIG_MODULES.has(tsModule)) return 'esm';
        if (tsModule === 'commonjs') return 'commonjs';
        if (tsModule === 'node16' || tsModule === 'nodenext') {
            // pkgType === 'module' already returned 'esm' above, so here it emits CJS.
            return 'commonjs';
        }
    }
    if (pkgType === 'commonjs') return 'commonjs';
    return 'unknown';
}

export function analyzeProject(targetDir: string): TransformContext {
    const moduleSystem = detectModuleSystem(targetDir);
    const pkgJsonPath = findPackageJson(targetDir);
    if (pkgJsonPath) {
        try {
            const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
            const allDeps = {
                ...pkgJson.dependencies,
                ...pkgJson.devDependencies
            };

            const hasClient = '@modelcontextprotocol/client' in allDeps;
            const hasServer = '@modelcontextprotocol/server' in allDeps;

            if (hasClient && hasServer) return { projectType: 'both', moduleSystem };
            if (hasClient) return { projectType: 'client', moduleSystem };
            if (hasServer) return { projectType: 'server', moduleSystem };
            // No v2 split deps — this is almost always a v1 project mid-migration (v1 ships as the single
            // `@modelcontextprotocol/sdk` package). Fall through to inferring the type from source usage.
        } catch {
            // Malformed package.json — fall through to source inference.
        }
    }

    return { projectType: inferProjectTypeFromSource(targetDir), moduleSystem };
}

/**
 * Infer client vs server vs both by scanning the source for v1 SDK subpath imports: a
 * `@modelcontextprotocol/sdk/client/...` specifier means the project will need
 * `@modelcontextprotocol/client`; a `.../server/...` specifier means it needs `@modelcontextprotocol/server`.
 * Files that import only shared paths (`types.js`, `shared/...`) give no signal. The scan matches quoted
 * specifiers (not bare substrings), so comments/prose are ignored. Bounded: skips heavy dirs, caps the
 * file count, and early-exits once both signals are seen.
 */
function inferProjectTypeFromSource(targetDir: string): TransformContext['projectType'] {
    let usesClient = false;
    let usesServer = false;
    let scanned = 0;

    const visit = (dir: string): void => {
        if (usesClient && usesServer) return;
        let entries: import('node:fs').Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (usesClient && usesServer) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SCAN_SKIP_DIRS.has(entry.name)) continue;
                visit(full);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (!SCAN_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts')) continue;
                if (scanned >= SCAN_FILE_BUDGET) return;
                scanned++;
                let content: string;
                try {
                    content = readFileSync(full, 'utf8');
                } catch {
                    continue;
                }
                if (!usesClient && CLIENT_IMPORT_RE.test(content)) usesClient = true;
                if (!usesServer && SERVER_IMPORT_RE.test(content)) usesServer = true;
            }
        }
    };

    let root = targetDir;
    try {
        if (!statSync(targetDir).isDirectory()) root = path.dirname(targetDir);
    } catch {
        return 'unknown';
    }
    visit(root);

    if (usesClient && usesServer) return 'both';
    if (usesClient) return 'client';
    if (usesServer) return 'server';
    return 'unknown';
}

export function resolveTypesPackage(
    context: TransformContext,
    fileHasClientImports: boolean,
    fileHasServerImports: boolean,
    diagnosticSink?: { filePath: string; line: number; diagnostics: Diagnostic[] }
): string {
    if (fileHasClientImports && !fileHasServerImports) {
        return '@modelcontextprotocol/client';
    }
    if (fileHasServerImports && !fileHasClientImports) {
        return '@modelcontextprotocol/server';
    }
    if (context.projectType === 'client') {
        return '@modelcontextprotocol/client';
    }
    if (context.projectType === 'server') {
        return '@modelcontextprotocol/server';
    }
    if (context.projectType === 'both') {
        // Both packages are present and both re-export the shared protocol types (from core), so importing
        // from either compiles. This file has no client/server-specific signal — default to server and note
        // it as an optional preference, not an action-required warning.
        if (diagnosticSink) {
            diagnosticSink.diagnostics.push(
                info(
                    diagnosticSink.filePath,
                    diagnosticSink.line,
                    'Shared protocol types imported from @modelcontextprotocol/server (both client and server ' +
                        're-export them). Switch to @modelcontextprotocol/client if this is client-only code.'
                )
            );
        }
        return '@modelcontextprotocol/server';
    }
    if (diagnosticSink) {
        diagnosticSink.diagnostics.push(
            warning(
                diagnosticSink.filePath,
                diagnosticSink.line,
                'Could not determine project type (client vs server). Defaulting to @modelcontextprotocol/server. ' +
                    'If this is a client-only project, adjust imports manually.'
            )
        );
    }
    return '@modelcontextprotocol/server';
}
