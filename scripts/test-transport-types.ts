import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [profileArgument, compilerArgument] = process.argv.slice(2);
assert(profileArgument && compilerArgument, 'Usage: tsx scripts/test-transport-types.ts <installed-package-directory> <compiler-cli>');
const profile = resolve(profileArgument);
const compiler = resolve(compilerArgument);
assert(existsSync(compiler), `Compiler does not exist: ${compiler}`);
const packageDirectory = join(profile, 'node_modules', '@modelcontextprotocol', 'sdk');
assert(existsSync(join(packageDirectory, 'dist', 'esm', 'server', 'streamableHttp.d.ts')), 'Install the SDK package in the profile first');
const fixtures = fileURLToPath(new URL('./fixtures/transport-types/', import.meta.url));

const negativeCases = [
    { source: 'contract.onclose = 1;', code: 2322 },
    { source: 'contract.onclose = (required: string) => {};', code: 2322 },
    { source: 'contract.onerror = (error: string) => {};', code: 2322 },
    { source: 'contract.onmessage = (message: string) => {};', code: 2322 },
    { source: 'contract.onmessage = (message: JSONRPCMessage, extra: string) => {};', code: 2322 },
    { source: 'contract.onmessage = (message: JSONRPCRequest) => {};', code: 2322 },
    { source: 'contract.onclose = null;', code: 2322 },
    { source: 'contract.onerror = null;', code: 2322 },
    { source: 'contract.onmessage = null;', code: 2322 },
    { source: 'contract.onerror!();', code: 2554 },
    { source: 'contract.onmessage!();', code: 2554 },
    { source: 'contract.onerror!("not-an-error");', code: 2345 },
    { source: 'contract.onmessage!({ jsonrpc: "invalid", method: "ping" });', code: 2322 },
    { source: 'transport.onerror = (error: string) => {};', code: 2322 },
    { source: 'transport.onmessage = (message: string) => {};', code: 2322 },
    { source: 'transport.onclose = null;', code: 2322 },
    { source: 'normalizeHeaders(42);', code: 2345 },
    { source: 'normalizeHeaders({ authorization: ["example"] });', code: 2345 },
    { source: 'normalizeHeaders([["name"]]);', code: 2322 }
];

function compile(directory: string): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [compiler, '--project', join(directory, 'tsconfig.json'), '--pretty', 'false'], {
        encoding: 'utf8',
        timeout: 120_000
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
}

function checkConsumers(mode: 'esm' | 'cjs', lib: string[]): void {
    const extension = mode === 'esm' ? 'mts' : 'cts';
    const httpImport =
        mode === 'esm'
            ? "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';"
            : "import Http = require('@modelcontextprotocol/sdk/server/streamableHttp.js'); const { StreamableHTTPServerTransport } = Http;";
    const headersImport =
        mode === 'esm'
            ? "import { normalizeHeaders } from '@modelcontextprotocol/sdk/shared/transport.js';"
            : "import TransportModule = require('@modelcontextprotocol/sdk/shared/transport.js'); const { normalizeHeaders } = TransportModule;";
    const directory = mkdtempSync(join(profile, 'transport-types-'));
    try {
        const compilerOptions = {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib,
            types: ['node'],
            strict: true,
            noImplicitAny: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            skipLibCheck: false,
            declaration: true,
            emitDeclarationOnly: true,
            outDir: './declarations'
        };
        const config = join(directory, 'tsconfig.json');
        const files = [`consumer.${extension}`];
        if (lib.includes('DOM')) {
            files.push('headers-dom.mts');
            writeFileSync(
                join(directory, 'headers-dom.mts'),
                [
                    "import { normalizeHeaders } from '@modelcontextprotocol/sdk/shared/transport.js';",
                    'type Input = Parameters<typeof normalizeHeaders>[0];',
                    'type Original = HeadersInit | undefined;',
                    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
                    'const unchangedDomain: Equal<Input, Original> = true;',
                    'export { unchangedDomain };'
                ].join('\n')
            );
        }
        writeFileSync(config, JSON.stringify({ compilerOptions, files }));
        copyFileSync(join(fixtures, `consumer.${extension}`), join(directory, `consumer.${extension}`));
        let result = compile(directory);
        assert.equal(result.status, 0, `${lib.join(',')}: public consumer failed\n${result.output}`);
        const declaration = join(directory, 'declarations', `consumer.d.${extension}`);
        assert(existsSync(declaration), 'Consumer declaration was not emitted');
        assert(readFileSync(declaration, 'utf8').includes('@modelcontextprotocol/sdk/server/streamableHttp.js'));

        rmSync(join(directory, `consumer.${extension}`));
        const downstream = join(directory, 'downstream');
        mkdirSync(downstream);
        copyFileSync(declaration, join(downstream, `consumer.d.${extension}`));
        copyFileSync(join(fixtures, `downstream.${extension}`), join(downstream, `downstream.${extension}`));
        writeFileSync(
            config,
            JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true }, files: [`downstream/downstream.${extension}`] })
        );
        result = compile(directory);
        assert.equal(result.status, 0, `${lib.join(',')}: declaration-only downstream failed\n${result.output}`);
        assert(!existsSync(join(directory, `consumer.${extension}`)), 'First consumer source must not be available');

        const negativeFiles = negativeCases.map((_, index) => `negative-${index}.${extension}`);
        writeFileSync(config, JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true }, files: negativeFiles }));
        for (const [index, { source }] of negativeCases.entries()) {
            writeFileSync(
                join(directory, `negative-${index}.${extension}`),
                [
                    httpImport,
                    headersImport,
                    "import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';",
                    "import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';",
                    'const transport = new StreamableHTTPServerTransport();',
                    'const contract: Transport = transport;',
                    source
                ].join('\n')
            );
        }
        result = compile(directory);
        assert.notEqual(result.status, 0, 'Invalid callback/header types were accepted');
        assert.equal([...result.output.matchAll(/error TS\d+:/g)].length, negativeCases.length, result.output);
        for (const [index, { source, code }] of negativeCases.entries()) {
            assert.match(
                result.output,
                new RegExp(`negative-${index}\\.${extension}\\(7,\\d+\\): error TS${code}:`),
                `Expected diagnostic at the invalid expression: ${source}\n${result.output}`
            );
        }
        console.log(
            `${process.version}: ${mode}: ${lib.join(',')}: public consumer, declaration roundtrip, ${negativeCases.length} negative cases passed`
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

for (const mode of ['esm', 'cjs'] as const) {
    for (const lib of [['ES2022'], ['ES2022', 'DOM', 'DOM.Iterable']]) {
        checkConsumers(mode, lib);
    }
}
