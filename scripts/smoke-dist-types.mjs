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
try {
    writeFileSync(
        path.join(dir, 'consumer.ts'),
        [
            "import { Client } from '@modelcontextprotocol/client';",
            "import type { JsonSchemaValidator as ClientJsonSchemaValidator } from '@modelcontextprotocol/client';",
            "import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';",
            "import { CfWorkerJsonSchemaValidator as ClientCf } from '@modelcontextprotocol/client/validators/cf-worker';",
            "import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';",
            "import { McpServer } from '@modelcontextprotocol/server';",
            "import { AjvJsonSchemaValidator as ServerAjv } from '@modelcontextprotocol/server/validators/ajv';",
            "import { CfWorkerJsonSchemaValidator as ServerCf } from '@modelcontextprotocol/server/validators/cf-worker';",
            "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
            "export const c = new Client({ name: 'smoke', version: '1.0.0' });",
            "export const s = new McpServer({ name: 'smoke', version: '1.0.0' });",
            'export type T = ClientJsonSchemaValidator<unknown>;',
            'export { AjvJsonSchemaValidator, ServerAjv, ClientCf, ServerCf, StdioClientTransport, StdioServerTransport };',
            ''
        ].join('\n')
    );
    writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    skipLibCheck: false,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    target: 'es2022',
                    types: ['node'],
                    typeRoots: [path.join(repo, 'node_modules', '@types')],
                    paths: {
                        '@modelcontextprotocol/client': [path.join(repo, 'packages/client/dist/index.d.mts')],
                        '@modelcontextprotocol/client/validators/ajv': [path.join(repo, 'packages/client/dist/validators/ajv.d.mts')],
                        '@modelcontextprotocol/client/validators/cf-worker': [
                            path.join(repo, 'packages/client/dist/validators/cfWorker.d.mts')
                        ],
                        '@modelcontextprotocol/client/stdio': [path.join(repo, 'packages/client/dist/stdio.d.mts')],
                        '@modelcontextprotocol/server': [path.join(repo, 'packages/server/dist/index.d.mts')],
                        '@modelcontextprotocol/server/validators/ajv': [path.join(repo, 'packages/server/dist/validators/ajv.d.mts')],
                        '@modelcontextprotocol/server/validators/cf-worker': [
                            path.join(repo, 'packages/server/dist/validators/cfWorker.d.mts')
                        ],
                        '@modelcontextprotocol/server/stdio': [path.join(repo, 'packages/server/dist/stdio.d.mts')]
                    }
                },
                include: ['consumer.ts']
            },
            null,
            2
        )
    );
    execFileSync('pnpm', ['exec', 'tsc', '-p', dir], { cwd: repo, stdio: 'inherit' });
    console.log('dist-types smoke: clean (skipLibCheck: false)');
} finally {
    rmSync(dir, { recursive: true, force: true });
}
