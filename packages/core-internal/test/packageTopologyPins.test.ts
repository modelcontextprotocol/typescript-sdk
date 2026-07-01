/**
 * Behavior-surface pins: workspace package topology and export maps.
 *
 * The published surface of the SDK is the set of public packages and their
 * export-map entries. Consumers resolve deep subpaths through these maps, so
 * adding, removing, or renaming an entry — or flipping a private flag — is a
 * consumer-visible change. This pins the manifest-level topology: every change
 * to it must be deliberate (update the pin, add a changeset, and document the
 * migration). Runtime resolvability of the built entries is covered by the
 * integration test workspace.
 *
 * See docs/behavior-surface-pins.md for the maintenance protocol.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageManifest {
    name: string;
    private?: boolean;
    type?: string;
    files?: string[];
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
}

function readManifest(relativeDir: string): PackageManifest {
    return JSON.parse(readFileSync(join(packagesDir, relativeDir, 'package.json'), 'utf8')) as PackageManifest;
}

/** dir (relative to packages/) → expected manifest shape */
const PUBLIC_PACKAGES: Record<string, { name: string; exportKeys: string[]; bin?: Record<string, string> }> = {
    client: {
        name: '@modelcontextprotocol/client',
        exportKeys: ['.', './stdio', './validators/ajv', './validators/cf-worker', './_shims']
    },
    server: {
        name: '@modelcontextprotocol/server',
        exportKeys: ['.', './stdio', './validators/ajv', './validators/cf-worker', './_shims']
    },
    'server-legacy': {
        name: '@modelcontextprotocol/server-legacy',
        exportKeys: ['.', './sse', './auth']
    },
    'middleware/express': { name: '@modelcontextprotocol/express', exportKeys: ['.'] },
    'middleware/fastify': { name: '@modelcontextprotocol/fastify', exportKeys: ['.'] },
    'middleware/hono': { name: '@modelcontextprotocol/hono', exportKeys: ['.'] },
    'middleware/node': { name: '@modelcontextprotocol/node', exportKeys: ['.'] },
    core: {
        name: '@modelcontextprotocol/core',
        exportKeys: ['.']
    },
    codemod: {
        name: '@modelcontextprotocol/codemod',
        exportKeys: ['.'],
        bin: { 'mcp-codemod': './dist/cli.mjs' }
    }
};

describe('public package topology', () => {
    for (const [dir, expected] of Object.entries(PUBLIC_PACKAGES)) {
        describe(expected.name, () => {
            const manifest = readManifest(dir);

            test('is published under the pinned name', () => {
                expect(manifest.name).toBe(expected.name);
                expect(manifest.private).not.toBe(true);
            });

            test('export-map keys are pinned exactly', () => {
                expect(Object.keys(manifest.exports ?? {})).toEqual(expected.exportKeys);
            });

            test('publishes only dist', () => {
                expect(manifest.files).toEqual(['dist']);
            });

            if (expected.bin) {
                test('bin entries are pinned', () => {
                    expect(manifest.bin).toEqual(expected.bin);
                });
            } else {
                test('declares no bin entries', () => {
                    expect(manifest.bin).toBeUndefined();
                });
            }
        });
    }
});

describe('the package set itself is pinned', () => {
    /** Every directory under packages/ (one level, plus middleware/*) holding a package.json. */
    function discoverManifestDirs(): string[] {
        const dirs: string[] = [];
        for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (existsSync(join(packagesDir, entry.name, 'package.json'))) {
                dirs.push(entry.name);
                continue;
            }
            for (const nested of readdirSync(join(packagesDir, entry.name), { withFileTypes: true })) {
                if (nested.isDirectory() && existsSync(join(packagesDir, entry.name, nested.name, 'package.json'))) {
                    dirs.push(`${entry.name}/${nested.name}`);
                }
            }
        }
        return dirs.sort();
    }

    test('every manifest under packages/ is either a pinned public package or core', () => {
        // The workspace glob (packages/**/*) auto-adopts any new directory and
        // the changesets config publishes every non-private package, so the SET
        // of packages is itself published surface. A new package must be added
        // to PUBLIC_PACKAGES here deliberately (or pinned as private below) —
        // otherwise it would ship to npm without any pin applying to it.
        expect(discoverManifestDirs()).toEqual([...Object.keys(PUBLIC_PACKAGES), 'core-internal'].sort());
    });
});

describe('internal packages stay private', () => {
    test('@modelcontextprotocol/core-internal is private (bundled into client/server dists)', () => {
        const manifest = readManifest('core-internal');
        expect(manifest.name).toBe('@modelcontextprotocol/core-internal');
        expect(manifest.private).toBe(true);
    });

    test('the workspace root is private', () => {
        const manifest = JSON.parse(readFileSync(join(packagesDir, '..', 'package.json'), 'utf8')) as PackageManifest;
        expect(manifest.private).toBe(true);
    });
});
