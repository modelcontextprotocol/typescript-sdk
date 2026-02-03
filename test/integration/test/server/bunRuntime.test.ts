/**
 * Bun runtime integration test
 *
 * Verifies the MCP server package works in Bun runtime.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';

import type { RuntimeTestEnv } from '../helpers/runtimeTest.js';
import { assertEnvInitialized, isRuntimeAvailable, MCP_SERVER_SETUP, setupRuntimeTest, testMcpConnection } from '../helpers/runtimeTest.js';

const PORT = 8790;

describe('Bun runtime compatibility', () => {
    let env: RuntimeTestEnv | null = null;

    beforeAll(async () => {
        env = await setupRuntimeTest({
            name: 'bun',
            port: PORT,
            checkAvailable: () => isRuntimeAvailable('bun'),
            extraDeps: {
                '@cfworker/json-schema': '^4.1.1'
            },
            generateServerSource: port => `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

${MCP_SERVER_SETUP}

Bun.serve({
    port: ${port},
    fetch: (request) => transport.handleRequest(request)
});

console.log('Bun server listening on port ${port}');
`,
            spawnCommand: ['bun', 'run', 'server.ts'],
            readyPattern: /listening on port/
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
