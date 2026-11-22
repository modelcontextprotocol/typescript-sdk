import { describe, expect, it } from 'vitest';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';

describe('McpServer resource templates', () => {
    it.each([
        ['summary', 'revision'],
        ['revision', 'summary']
    ])('routes reads by the declared query keys with %s registered first', async (first, second) => {
        const server = new McpServer({ name: 'test', version: '1.0.0' });
        for (const key of [first, second]) {
            server.registerResource(
                key,
                new ResourceTemplate(`mem://library/document/{id}{?${key}}`, { list: undefined }),
                {},
                async (uri, variables) => ({ contents: [{ uri: uri.href, text: `${key}:${variables[key]}` }] })
            );
        }

        for (const [key, value] of [
            ['summary', 'compact'],
            ['revision', '42']
        ]) {
            const uri = `mem://library/document/1?${key}=${value}`;
            const response = await invoke(
                server,
                { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
                { classification: { era: 'legacy' } }
            );
            expect(await response.json()).toMatchObject({ result: { contents: [{ uri, text: `${key}:${value}` }] } });
        }
    });
});
