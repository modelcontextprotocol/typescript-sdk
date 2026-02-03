/**
 * Cloudflare Workers integration test
 *
 * Verifies the MCP server package works in Cloudflare Workers
 * WITHOUT nodejs_compat, using runtime shims for cross-platform compatibility.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';

import type { RuntimeTestEnv } from '../helpers/runtimeTest.js';
import { assertEnvInitialized, MCP_SERVER_SETUP, setupRuntimeTest, testMcpConnection } from '../helpers/runtimeTest.js';

const PORT = 8787;

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let env: RuntimeTestEnv | null = null;

    beforeAll(async () => {
        env = await setupRuntimeTest({
            name: 'cloudflare-workers',
            port: PORT,
            checkAvailable: () => true, // wrangler installed via npm
            extraDeps: {
                '@cfworker/json-schema': '^4.1.1'
            },
            extraDevDeps: {
                wrangler: '^4.14.4'
            },
            extraFiles: {
                'wrangler.jsonc': JSON.stringify(
                    {
                        $schema: 'node_modules/wrangler/config-schema.json',
                        name: 'cf-worker-test',
                        main: 'server.ts',
                        compatibility_date: '2026-02-03'
                    },
                    null,
                    2
                )
            },
            generateServerSource: () => `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

${MCP_SERVER_SETUP}

export default {
    fetch: (request) => transport.handleRequest(request)
};
`,
            spawnCommand: ['npx', 'wrangler', 'dev', '--local', '--port', String(PORT)],
            readyPattern: /Ready on|Listening on/,
            fatalErrorPattern: /No such module "node:/,
            readyDelay: 1000
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
