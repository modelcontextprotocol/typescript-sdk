import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { updatePackageJson } from '../src/utils/packageJsonUpdater.js';

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-pkgjson-'));
    return tempDir;
}

function writePkgJson(dir: string, content: Record<string, unknown>, indent: string | number = 2): void {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(content, null, indent) + '\n');
}

function readPkgJson(dir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('updatePackageJson', () => {
    it('removes v1 SDK from dependencies and adds v2 packages', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0',
                express: '^4.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);

        expect(result).toBeDefined();
        expect(result!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result!.added).toContain('@modelcontextprotocol/server');

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['@modelcontextprotocol/server']).toBeDefined();
        expect(deps['express']).toBe('^4.0.0');
    });

    it('removes v1 SDK from devDependencies and adds v2 packages there', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            devDependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/client']), false);

        expect(result).toBeDefined();
        const pkg = readPkgJson(dir);
        const devDeps = pkg.devDependencies as Record<string, string>;
        expect(devDeps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(devDeps['@modelcontextprotocol/client']).toBeDefined();
    });

    it('removes v1 SDK from both sections, adds v2 to dependencies only', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            },
            devDependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);

        expect(result).toBeDefined();
        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        const devDeps = pkg.devDependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(devDeps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['@modelcontextprotocol/server']).toBeDefined();
        expect(devDeps['@modelcontextprotocol/server']).toBeUndefined();
    });

    it('skips v2 packages that are already present', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0',
                '@modelcontextprotocol/server': '^2.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server', '@modelcontextprotocol/node']), false);

        expect(result).toBeDefined();
        expect(result!.added).toContain('@modelcontextprotocol/node');
        expect(result!.added).not.toContain('@modelcontextprotocol/server');
    });

    it('returns undefined when no package.json exists', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        mkdirSync(path.join(dir, 'src'), { recursive: true });

        const result = updatePackageJson(path.join(dir, 'src'), new Set(['@modelcontextprotocol/server']), false);
        expect(result).toBeUndefined();
    });

    it('returns undefined when v1 SDK is not in package.json', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                express: '^4.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);
        expect(result).toBeUndefined();
    });

    it('does not write file in dry-run mode', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), true);

        expect(result).toBeDefined();
        expect(result!.added).toContain('@modelcontextprotocol/server');

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBe('^1.0.0');
        expect(deps['@modelcontextprotocol/server']).toBeUndefined();
    });

    it('filters out @modelcontextprotocol/core (private package)', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/core', '@modelcontextprotocol/server']), false);

        expect(result).toBeDefined();
        expect(result!.added).not.toContain('@modelcontextprotocol/core');
        expect(result!.added).toContain('@modelcontextprotocol/server');

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/core']).toBeUndefined();
    });

    it('preserves 4-space indentation', () => {
        const dir = createTempDir();
        writePkgJson(
            dir,
            {
                dependencies: {
                    '@modelcontextprotocol/sdk': '^1.0.0'
                }
            },
            4
        );

        updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);

        const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
        expect(raw).toContain('    "dependencies"');
    });

    it('preserves trailing newline', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);

        const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
        expect(raw.endsWith('\n')).toBe(true);
        expect(raw.endsWith('\n\n')).toBe(false);
    });

    it('removes v1 SDK even when no v2 packages are detected', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0',
                express: '^4.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(), false);

        expect(result).toBeDefined();
        expect(result!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result!.added).toEqual([]);

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['express']).toBe('^4.0.0');
    });

    it('version strings have caret range format', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/server']).toMatch(/^\^/);
    });

    it('returns undefined for malformed package.json', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'package.json'), '{ invalid json }');

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/server']), false);
        expect(result).toBeUndefined();
    });

    it('normalizes subpath packages to root before adding to package.json', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/client/stdio']), false);

        expect(result).toBeDefined();
        expect(result!.added).toContain('@modelcontextprotocol/client');

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/client']).toBeDefined();
    });

    it('deduplicates root and subpath packages', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(dir, new Set(['@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio']), false);

        expect(result).toBeDefined();
        expect(result!.added.filter(p => p === '@modelcontextprotocol/client')).toHaveLength(1);
    });

    it('adds multiple v2 packages', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });

        const result = updatePackageJson(
            dir,
            new Set(['@modelcontextprotocol/server', '@modelcontextprotocol/node', '@modelcontextprotocol/express']),
            false
        );

        expect(result).toBeDefined();
        expect(result!.added).toEqual(['@modelcontextprotocol/express', '@modelcontextprotocol/node', '@modelcontextprotocol/server']);

        const pkg = readPkgJson(dir);
        const deps = pkg.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/server']).toBeDefined();
        expect(deps['@modelcontextprotocol/node']).toBeDefined();
        expect(deps['@modelcontextprotocol/express']).toBeDefined();
    });
});
