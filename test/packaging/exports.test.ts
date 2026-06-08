/**
 * Package export map smoke test.
 *
 * Builds the real publishable artifact (`npm pack`, which runs the prepack build),
 * installs it into a throwaway project (offline: the tarball is unpacked into the
 * project's node_modules and the repo's own node_modules is link-shared for the
 * package's runtime dependencies), and then resolves every public entry point THROUGH
 * the package export map — both `import` (ESM, dist/esm) and `require` (CJS, dist/cjs)
 * conditions — asserting each one resolves and exposes its expected primary symbol(s).
 *
 * Covered entries: the named export-map groups (./client, ./server, ./validation,
 * ./validation/ajv, ./validation/cfworker) plus the deep subpath imports consumers use
 * in practice, all of which currently resolve only via the './*' wildcard export —
 * replacing that wildcard with an explicit list that misses one of them would otherwise
 * be an uncaught ecosystem break, because every in-repo test imports from src/ directly.
 *
 * Note on the root entry: package.json declares a '.' export pointing at dist/esm/index.js
 * (and dist/cjs/index.js), but no src/index.ts exists, so the build does not produce that
 * file and a bare root import has never resolved. The manifest pin below asserts the '.'
 * key stays declared; its (non-)resolution is deliberately not asserted so a future fix
 * that adds a real root barrel is not blocked by this suite.
 *
 * How it runs: `npm run test:packaging`. It is excluded from the plain `npm test` run
 * because it rebuilds and packs the package first (slower, and it rewrites dist/);
 * run it explicitly — or in CI — alongside the unit suite.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ProbeTarget {
    subpath: string;
    symbols: string[];
    errorClassCheck?: boolean;
}

interface ProbeResult {
    subpath: string;
    ok: boolean;
    error?: string;
    missing?: string[];
    errorClassOk?: boolean | null;
}

/** Named (non-wildcard) export-map groups. */
const NAMED_ENTRIES: ProbeTarget[] = [
    { subpath: '@modelcontextprotocol/sdk/client', symbols: ['Client'] },
    { subpath: '@modelcontextprotocol/sdk/server', symbols: ['Server'] },
    // ./validation has no runtime exports (type-only module) — resolution itself is the assertion
    { subpath: '@modelcontextprotocol/sdk/validation', symbols: [] },
    { subpath: '@modelcontextprotocol/sdk/validation/ajv', symbols: ['AjvJsonSchemaValidator'] },
    { subpath: '@modelcontextprotocol/sdk/validation/cfworker', symbols: ['CfWorkerJsonSchemaValidator'] }
];

/** Deep subpath imports used by downstream consumers; today these resolve via the './*' wildcard. */
const CONSUMER_SUBPATHS: ProbeTarget[] = [
    { subpath: '@modelcontextprotocol/sdk/types.js', symbols: ['McpError', 'ErrorCode', 'CallToolResultSchema'], errorClassCheck: true },
    { subpath: '@modelcontextprotocol/sdk/client/index.js', symbols: ['Client'] },
    { subpath: '@modelcontextprotocol/sdk/client/auth.js', symbols: ['auth', 'UnauthorizedError'] },
    { subpath: '@modelcontextprotocol/sdk/client/stdio.js', symbols: ['StdioClientTransport', 'getDefaultEnvironment'] },
    { subpath: '@modelcontextprotocol/sdk/client/sse.js', symbols: ['SSEClientTransport', 'SseError'] },
    { subpath: '@modelcontextprotocol/sdk/client/streamableHttp.js', symbols: ['StreamableHTTPClientTransport', 'StreamableHTTPError'] },
    { subpath: '@modelcontextprotocol/sdk/server/index.js', symbols: ['Server'] },
    { subpath: '@modelcontextprotocol/sdk/server/mcp.js', symbols: ['McpServer', 'ResourceTemplate'] },
    { subpath: '@modelcontextprotocol/sdk/server/stdio.js', symbols: ['StdioServerTransport'] },
    { subpath: '@modelcontextprotocol/sdk/server/auth/errors.js', symbols: ['InvalidRequestError', 'OAUTH_ERRORS'] },
    { subpath: '@modelcontextprotocol/sdk/shared/transport.js', symbols: ['createFetchWithInit'] },
    { subpath: '@modelcontextprotocol/sdk/shared/auth.js', symbols: ['OAuthMetadataSchema', 'OAuthTokensSchema'] },
    { subpath: '@modelcontextprotocol/sdk/shared/stdio.js', symbols: ['ReadBuffer', 'serializeMessage', 'deserializeMessage'] }
];

const ALL_TARGETS: ProbeTarget[] = [...NAMED_ENTRIES, ...CONSUMER_SUBPATHS];

const ESM_PROBE = `
import fs from 'node:fs';
const targets = JSON.parse(fs.readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));
const results = [];
for (const t of targets) {
    try {
        const m = await import(t.subpath);
        const missing = t.symbols.filter(s => typeof m[s] === 'undefined');
        let errorClassOk = null;
        if (t.errorClassCheck) {
            const e = new m.McpError(-32600, 'probe');
            errorClassOk = e.name === 'McpError' && e instanceof Error && e.code === -32600;
        }
        results.push({ subpath: t.subpath, ok: true, missing, errorClassOk });
    } catch (err) {
        results.push({ subpath: t.subpath, ok: false, error: String((err && err.message) || err) });
    }
}
process.stdout.write(JSON.stringify(results));
`;

const CJS_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const targets = JSON.parse(fs.readFileSync(path.join(__dirname, 'targets.json'), 'utf8'));
const results = [];
for (const t of targets) {
    try {
        const m = require(t.subpath);
        const missing = t.symbols.filter(s => typeof m[s] === 'undefined');
        let errorClassOk = null;
        if (t.errorClassCheck) {
            const e = new m.McpError(-32600, 'probe');
            errorClassOk = e.name === 'McpError' && e instanceof Error && e.code === -32600;
        }
        results.push({ subpath: t.subpath, ok: true, missing, errorClassOk });
    } catch (err) {
        results.push({ subpath: t.subpath, ok: false, error: String((err && err.message) || err) });
    }
}
process.stdout.write(JSON.stringify(results));
`;

let workDir: string;
let installedPackageDir: string;
let esmResults: Map<string, ProbeResult>;
let cjsResults: Map<string, ProbeResult>;

function runProbe(projectDir: string, file: string): Map<string, ProbeResult> {
    const stdout = execFileSync(process.execPath, [file], { cwd: projectDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const parsed: ProbeResult[] = JSON.parse(stdout);
    return new Map(parsed.map(r => [r.subpath, r]));
}

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-smoke-'));

    // 1. Build the publishable artifact. npm pack runs the prepack build (ESM + CJS).
    execFileSync('npm', ['pack', '--pack-destination', workDir], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const tarball = fs.readdirSync(workDir).find(f => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');

    // 2. Unpack it (tar root is "package/").
    execFileSync('tar', ['-xzf', path.join(workDir, tarball), '-C', workDir], { encoding: 'utf8' });

    // 3. Throwaway consumer project: the unpacked package goes into node_modules under
    //    its real name, and the repo's node_modules entries are symlinked alongside it
    //    so the package's runtime dependencies resolve without touching the network.
    const projectDir = path.join(workDir, 'consumer');
    const nodeModules = path.join(projectDir, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'export-map-probe', private: true }));
    for (const entry of fs.readdirSync(path.join(repoRoot, 'node_modules'))) {
        if (entry === '.bin' || entry === '.package-lock.json' || entry === '@modelcontextprotocol') continue;
        fs.symlinkSync(path.join(repoRoot, 'node_modules', entry), path.join(nodeModules, entry));
    }
    const scopeDir = path.join(nodeModules, '@modelcontextprotocol');
    fs.mkdirSync(scopeDir);
    installedPackageDir = path.join(scopeDir, 'sdk');
    fs.renameSync(path.join(workDir, 'package'), installedPackageDir);

    // 4. Resolve every entry through the export map from both module systems.
    fs.writeFileSync(path.join(projectDir, 'targets.json'), JSON.stringify(ALL_TARGETS));
    fs.writeFileSync(path.join(projectDir, 'probe.mjs'), ESM_PROBE);
    fs.writeFileSync(path.join(projectDir, 'probe.cjs'), CJS_PROBE);
    esmResults = runProbe(projectDir, 'probe.mjs');
    cjsResults = runProbe(projectDir, 'probe.cjs');
}, 300_000);

afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describe('package export map', () => {
    for (const target of ALL_TARGETS) {
        it(`resolves ${target.subpath} via import (ESM)`, () => {
            const r = esmResults.get(target.subpath);
            expect(r, 'probe produced no result').toBeDefined();
            expect(r?.ok, r?.error).toBe(true);
            expect(r?.missing, `missing expected symbol(s)`).toEqual([]);
        });

        it(`resolves ${target.subpath} via require (CJS)`, () => {
            const r = cjsResults.get(target.subpath);
            expect(r, 'probe produced no result').toBeDefined();
            expect(r?.ok, r?.error).toBe(true);
            expect(r?.missing, `missing expected symbol(s)`).toEqual([]);
        });
    }

    it('declares the expected export-map keys in the packed manifest', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(installedPackageDir, 'package.json'), 'utf8'));
        const keys = Object.keys(manifest.exports ?? {});
        for (const expected of ['.', './client', './server', './validation', './validation/ajv', './validation/cfworker', './*']) {
            expect(keys, `export map lost the '${expected}' entry`).toContain(expected);
        }
    });

    it('ships dual-package dist trees with correct module-format markers', () => {
        const esmMarker = JSON.parse(fs.readFileSync(path.join(installedPackageDir, 'dist', 'esm', 'package.json'), 'utf8'));
        const cjsMarker = JSON.parse(fs.readFileSync(path.join(installedPackageDir, 'dist', 'cjs', 'package.json'), 'utf8'));
        expect(esmMarker.type).toBe('module');
        expect(cjsMarker.type).toBe('commonjs');
    });

    it('preserves the public error class identity in both built module formats', () => {
        // Guards the `name === 'McpError'` contract against build/minification drift —
        // consumers discriminate SDK errors by .name and .code, not instanceof.
        expect(esmResults.get('@modelcontextprotocol/sdk/types.js')?.errorClassOk).toBe(true);
        expect(cjsResults.get('@modelcontextprotocol/sdk/types.js')?.errorClassOk).toBe(true);
    });
});
