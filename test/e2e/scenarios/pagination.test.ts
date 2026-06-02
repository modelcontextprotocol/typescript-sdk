/**
 * Self-contained test bodies for cursor-pagination behaviors that span all
 * paginated list operations (tools/list, resources/list,
 * resources/templates/list, prompts/list).
 */

import { expect } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { McpServer, ResourceTemplate } from '../../../src/server/mcp.js';
import { ErrorCode, isJSONRPCRequest, ListToolsRequestSchema, McpError, type Tool } from '../../../src/types.js';

import { tapWire, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

verifies('pagination:invalid-cursor', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({}) }, () => ({ content: [] }));
        s.registerResource('static', 'e2e://static', {}, uri => ({
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hi' }]
        }));
        s.registerResource('tpl', new ResourceTemplate('e2e://item/{id}', { list: undefined }), {}, uri => ({
            contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hi' }]
        }));
        s.registerPrompt('p', {}, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }));
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const badCursor = 'not-a-cursor-the-server-ever-issued';
    const invalidParams = expect.objectContaining({ code: ErrorCode.InvalidParams });

    await expect(client.listTools({ cursor: badCursor })).rejects.toBeInstanceOf(McpError);
    await expect(client.listTools({ cursor: badCursor })).rejects.toEqual(invalidParams);
    await expect(client.listResources({ cursor: badCursor })).rejects.toEqual(invalidParams);
    await expect(client.listResourceTemplates({ cursor: badCursor })).rejects.toEqual(invalidParams);
    await expect(client.listPrompts({ cursor: badCursor })).rejects.toEqual(invalidParams);
});

verifies('pagination:client:cursor-handling', async ({ transport }: TestArgs) => {
    // Cursors are deliberately base64-padded / URL-unsafe / JSON-looking so any client-side parsing or normalization would corrupt them.
    const cursorToPage2 = 'eyJvZmZzZXQiOjMsInYiOjF9==/page-2?after=get_alerts';
    const cursorToPage3 = 'YWZ0ZXI+Y29udmVydF91bml0cw==';
    // Page sizes of 3, 1, 2 prove the client follows nextCursor only and assumes no fixed page size.
    const pages = new Map<string | undefined, { tools: Tool[]; nextCursor?: string }>([
        [
            undefined,
            {
                tools: [
                    { name: 'get_weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
                    { name: 'get_forecast', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
                    { name: 'get_alerts', inputSchema: { type: 'object', properties: { region: { type: 'string' } } } }
                ],
                nextCursor: cursorToPage2
            }
        ],
        [
            cursorToPage2,
            {
                tools: [{ name: 'convert_units', inputSchema: { type: 'object', properties: { value: { type: 'number' } } } }],
                nextCursor: cursorToPage3
            }
        ],
        [
            cursorToPage3,
            {
                tools: [
                    { name: 'list_stations', inputSchema: { type: 'object', properties: {} } },
                    { name: 'get_station', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }
                ]
            }
        ]
    ]);
    const receivedCursors: Array<string | undefined> = [];

    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, req => {
            const cursor = req.params?.cursor;
            receivedCursors.push(cursor);
            const page = pages.get(cursor);
            if (!page) throw new McpError(ErrorCode.InvalidParams, `Unknown cursor: ${String(cursor)}`);
            return { tools: page.tools, nextCursor: page.nextCursor };
        });
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);
    const tap = tapWire(client);

    const collectedPages: string[][] = [];
    let result = await client.listTools();
    collectedPages.push(result.tools.map(t => t.name));
    while (result.nextCursor !== undefined) {
        // A run-away loop means the test fixture, not the SDK, is broken — fail fast instead of hitting the suite timeout.
        if (collectedPages.length >= pages.size) throw new Error('nextCursor still present after the last page');
        result = await client.listTools({ cursor: result.nextCursor });
        collectedPages.push(result.tools.map(t => t.name));
    }

    // The handler got back exactly the cursors it issued, and every page arrived once, in order.
    expect(receivedCursors).toEqual([undefined, cursorToPage2, cursorToPage3]);
    expect(collectedPages).toEqual([['get_weather', 'get_forecast', 'get_alerts'], ['convert_units'], ['list_stations', 'get_station']]);

    // The wire requests carried the server-issued strings byte-for-byte — opaque, unparsed, unmodified.
    const wireListRequests = tap.sent.filter(isJSONRPCRequest).filter(m => m.method === 'tools/list');
    expect(wireListRequests.map(m => m.params?.cursor)).toEqual([undefined, cursorToPage2, cursorToPage3]);
});
