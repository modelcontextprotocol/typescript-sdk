/**
 * Deno runtime integration test
 *
 * Verifies the MCP server package works in Deno runtime.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';

import type { RuntimeTestEnv } from '../helpers/runtimeTest.js';
import { assertEnvInitialized, isRuntimeAvailable, MCP_SERVER_SETUP, setupRuntimeTest, testMcpConnection } from '../helpers/runtimeTest.js';

const PORT = 8789;

describe('Deno runtime compatibility', () => {
    let env: RuntimeTestEnv | null = null;

    beforeAll(async () => {
        env = await setupRuntimeTest({
            name: 'deno',
            port: PORT,
            checkAvailable: () => isRuntimeAvailable('deno'),
            extraDeps: {
                '@cfworker/json-schema': '^4.1.1'
            },
            extraFiles: {
                'deno.json': JSON.stringify(
                    {
                        nodeModulesDir: 'manual',
                        unstable: ['byonm']
                    },
                    null,
                    2
                )
            },
            generateServerSource: port => `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

${MCP_SERVER_SETUP}

console.log('Deno server listening on port ${port}');

Deno.serve({ port: ${port} }, (request) => transport.handleRequest(request));
`,
            spawnCommand: ['deno', 'run', '--allow-net', '--allow-read', '--allow-env', 'server.ts'],
            readyPattern: /listening on port|Listening on/,
            readyDelay: 2000,
            startupTimeout: 60_000
        });
    }, 120_000);

    afterAll(async () => {
        await env?.cleanup();
    });

    it('should handle MCP requests', async () => {
        assertEnvInitialized(env);
        await testMcpConnection(PORT);
    });
});
