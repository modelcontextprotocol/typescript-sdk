/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/2838
 *
 * In the stateless `createMcpHandler(() => buildServer())` pattern the app builds
 * a fresh `McpServer` per request and re-registers its tools on it. The per-server
 * `_toolInputSchemaJson` memo never hits across instances, so every request paid a
 * full zod→JSON-Schema conversion for every tool. With the conversion memoized
 * process-wide (keyed by schema identity), an app that hoists its schemas to
 * module scope converts each one once, no matter how many `McpServer` instances
 * register it — and `tools/list` on a fresh instance reuses the same conversion.
 */
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };

describe('registerTool schema conversion memoization (#2838)', () => {
    it('converts a hoisted schema once across per-request McpServer instances and tools/list calls', async () => {
        let inputConversions = 0;
        // Module-scope ("hoisted") schema, as in the recommended stateless pattern.
        // A structural Standard Schema double keeps the count observable; zod's own
        // `~standard.jsonSchema` converter cannot be spied on.
        const hoisted: StandardSchemaWithJSON = {
            '~standard': {
                version: 1,
                vendor: 'stateless-repro',
                validate: value => ({ value }),
                jsonSchema: {
                    input: () => {
                        inputConversions++;
                        return { type: 'object', properties: { value: { type: 'string' } } };
                    },
                    output: () => {
                        throw new Error('output conversion must not run for an input-only tool');
                    }
                }
            }
        };

        const REQUESTS = 25;
        const servers: McpServer[] = [];
        for (let i = 0; i < REQUESTS; i++) {
            const server = new McpServer({ name: 'stateless', version: '0' });
            server.registerTool('echo', { inputSchema: hoisted }, async () => ({ content: [] }));
            servers.push(server);
        }
        expect(inputConversions).toBe(1);

        // `tools/list` on any of those instances reuses the memoized conversion.
        for (const server of servers) {
            const response = await invoke(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, LEGACY);
            expect(response.status).toBe(200);
        }
        expect(inputConversions).toBe(1);
    });
});
