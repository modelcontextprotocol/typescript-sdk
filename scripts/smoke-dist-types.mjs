// Compiles a small consumer against the BUILT declaration files with
// `skipLibCheck: false`, catching dangling type references that the dts
// bundler emits only as non-fatal warnings (its failOnWarn does not fail on
// MISSING_EXPORT). Run after `pnpm build:all`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'dist-types-smoke-'));
const serverConsumerLines = [
    "import { McpServer } from '@modelcontextprotocol/server';",
    "import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';",
    "export const s = new McpServer({ name: 'smoke', version: '1.0.0' });",
    'declare const outputSchema: StandardSchemaWithJSON<unknown, { answer: string }>;',
    "s.registerTool('typed-output', { outputSchema }, async () => ({ content: [], structuredContent: { answer: 'ok' } }));",
    '// @ts-expect-error built declarations must reject output that does not match the schema',
    "s.registerTool('invalid-output', { outputSchema }, async () => ({ content: [], structuredContent: { answer: 1 } }));",
    'declare const unknownOutputSchema: StandardSchemaWithJSON<unknown, unknown>;',
    "s.registerTool('unknown-null-output', { outputSchema: unknownOutputSchema }, async () => ({ content: [], structuredContent: null }));",
    '// @ts-expect-error runtime treats undefined structuredContent as absent even when schema output is unknown',
    "s.registerTool('unknown-undefined-output', { outputSchema: unknownOutputSchema }, async () => ({ content: [], structuredContent: undefined }));"
];
const esmConsumerSource = [
    "import { Client } from '@modelcontextprotocol/client';",
    "import type { JsonSchemaType as ClientSchema } from '@modelcontextprotocol/client';",
    "import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';",
    "import { CfWorkerJsonSchemaValidator as ClientCf } from '@modelcontextprotocol/client/validators/cf-worker';",
    "import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';",
    "import { AjvJsonSchemaValidator as ServerAjv } from '@modelcontextprotocol/server/validators/ajv';",
    "import { CfWorkerJsonSchemaValidator as ServerCf } from '@modelcontextprotocol/server/validators/cf-worker';",
    "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
    "export const c = new Client({ name: 'smoke', version: '1.0.0' });",
    ...serverConsumerLines,
    'export type T = ClientSchema;',
    'export { AjvJsonSchemaValidator, ServerAjv, ClientCf, ServerCf, StdioClientTransport, StdioServerTransport };',
    ''
].join('\n');

const declarationPaths = extension => ({
    '@modelcontextprotocol/client': [path.join(repo, `packages/client/dist/index${extension}`)],
    '@modelcontextprotocol/client/validators/ajv': [path.join(repo, `packages/client/dist/validators/ajv${extension}`)],
    '@modelcontextprotocol/client/validators/cf-worker': [path.join(repo, `packages/client/dist/validators/cfWorker${extension}`)],
    '@modelcontextprotocol/client/stdio': [path.join(repo, `packages/client/dist/stdio${extension}`)],
    '@modelcontextprotocol/server': [path.join(repo, `packages/server/dist/index${extension}`)],
    '@modelcontextprotocol/server/validators/ajv': [path.join(repo, `packages/server/dist/validators/ajv${extension}`)],
    '@modelcontextprotocol/server/validators/cf-worker': [path.join(repo, `packages/server/dist/validators/cfWorker${extension}`)],
    '@modelcontextprotocol/server/stdio': [path.join(repo, `packages/server/dist/stdio${extension}`)]
});

try {
    for (const format of [
        {
            name: 'esm',
            source: 'consumer.mts',
            consumerSource: esmConsumerSource,
            extension: '.d.mts',
            module: 'esnext',
            moduleResolution: 'bundler'
        },
        {
            name: 'cjs',
            source: 'consumer.cts',
            consumerSource: [...serverConsumerLines, ''].join('\n'),
            extension: '.d.cts',
            module: 'node16',
            moduleResolution: 'node16'
        }
    ]) {
        writeFileSync(path.join(dir, format.source), format.consumerSource);
        const configPath = path.join(dir, `tsconfig.${format.name}.json`);
        writeFileSync(
            configPath,
            JSON.stringify(
                {
                    compilerOptions: {
                        strict: true,
                        noEmit: true,
                        skipLibCheck: false,
                        module: format.module,
                        moduleResolution: format.moduleResolution,
                        target: 'es2022',
                        types: ['node'],
                        typeRoots: [path.join(repo, 'node_modules', '@types')],
                        paths: declarationPaths(format.extension)
                    },
                    include: [format.source]
                },
                null,
                2
            )
        );
        execFileSync('pnpm', ['exec', 'tsc', '-p', configPath], { cwd: repo, stdio: 'inherit' });
    }
    console.log('dist-types smoke: ESM and CJS clean (skipLibCheck: false)');
} finally {
    rmSync(dir, { recursive: true, force: true });
}
