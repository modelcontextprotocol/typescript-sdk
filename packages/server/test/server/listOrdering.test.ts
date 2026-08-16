/**
 * SF-02 — deterministic list ordering across requests.
 *
 * The spec recommends servers return tools/prompts/resources in a stable,
 * deterministic order across requests when the underlying set has not changed.
 * `McpServer` registries are plain string-keyed objects, so iteration is
 * insertion order; this test pins that ordering at the wire so a registry
 * refactor cannot quietly change it.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';

const LEGACY = { classification: { era: 'legacy' as const } };

const list = async (server: McpServer, method: string, key: string): Promise<string[]> => {
    const response = await invoke(server, { jsonrpc: '2.0', id: 1, method, params: {} }, LEGACY);
    const body = (await response.json()) as { result: Record<string, Array<{ name: string }>> };
    return body.result[key]!.map(item => item.name);
};

describe('McpServer list ordering', () => {
    it('tools/list, prompts/list and resources/list each return in registration order, stable across calls', async () => {
        const server = new McpServer({ name: 'ordering', version: '0' });

        // Non-sorted registration order so neither alphabetic nor reverse would mask it.
        const toolOrder = ['gamma', 'alpha', 'mu', 'beta'];
        for (const name of toolOrder) {
            server.registerTool(name, { inputSchema: z.object({}) }, async () => ({ content: [] }));
        }

        const promptOrder = ['second', 'first', 'third'];
        for (const name of promptOrder) {
            server.registerPrompt(name, {}, async () => ({ messages: [] }));
        }

        const resourceOrder = ['c', 'a', 'b'];
        for (const name of resourceOrder) {
            server.registerResource(name, `mem://${name}`, {}, async () => ({ contents: [] }));
        }

        expect(await list(server, 'tools/list', 'tools')).toEqual(toolOrder);
        expect(await list(server, 'tools/list', 'tools')).toEqual(toolOrder);
        expect(await list(server, 'prompts/list', 'prompts')).toEqual(promptOrder);
        expect(await list(server, 'prompts/list', 'prompts')).toEqual(promptOrder);
        expect(await list(server, 'resources/list', 'resources')).toEqual(resourceOrder);
        expect(await list(server, 'resources/list', 'resources')).toEqual(resourceOrder);
    });
});
