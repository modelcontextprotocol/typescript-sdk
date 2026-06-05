/**
 * Self-contained test bodies for dynamic (list_changed) behaviors.
 *
 * Tests for client-side listChanged handlers (auto-refresh, capability gating,
 * signal-only mode) and server-side dynamic registration (post-connect,
 * debounce, enable/disable, low-level handler reach-through).
 */

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { McpServer, type RegisteredTool } from '../../../src/server/mcp.js';
import { Server } from '../../../src/server/index.js';
import {
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    PromptListChangedNotificationSchema,
    ResourceListChangedNotificationSchema,
    SubscribeRequestSchema,
    ToolListChangedNotificationSchema,
    type Prompt,
    type Resource,
    type Tool
} from '../../../src/types.js';

import { wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

// vi.waitFor only retries on throw, not on falsy return — wrap predicates so a
// false result throws and the poll continues.
const waitUntil = (pred: () => boolean) => vi.waitFor(() => expect(pred()).toBe(true));

verifies('client:list-changed:auto-refresh', async ({ transport, protocolVersion }: TestArgs) => {
    const toolCalls: Array<{ error: Error | null; items: Tool[] | null }> = [];
    const promptCalls: Array<{ error: Error | null; items: Prompt[] | null }> = [];
    const resourceCalls: Array<{ error: Error | null; items: Resource[] | null }> = [];

    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerTool('seed', { inputSchema: z.object({}) }, () => ({ content: [] }));
        server.registerPrompt('seed', { description: '' }, () => ({ messages: [] }));
        server.registerResource('seed', 'test://seed', {}, () => ({ contents: [] }));
        return server;
    };

    const client = new Client(
        { name: 'c', version: '0' },
        {
            listChanged: {
                tools: { debounceMs: 0, onChanged: (error, items) => toolCalls.push({ error, items }) },
                prompts: { debounceMs: 0, onChanged: (error, items) => promptCalls.push({ error, items }) },
                resources: { debounceMs: 0, onChanged: (error, items) => resourceCalls.push({ error, items }) }
            }
        }
    );

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    server.registerTool('probe-tool', { inputSchema: z.object({}) }, () => ({ content: [] }));
    await waitUntil(() => toolCalls.some(c => c.items?.some(t => t.name === 'probe-tool')));
    const toolCall = toolCalls.find(c => c.items?.some(t => t.name === 'probe-tool'));
    expect(toolCall?.error).toBeNull();
    expect(toolCall?.items?.map(t => t.name)).toContain('probe-tool');

    server.registerPrompt('probe-prompt', { description: '' }, () => ({ messages: [] }));
    await waitUntil(() => promptCalls.some(c => c.items?.some(p => p.name === 'probe-prompt')));
    const promptCall = promptCalls.find(c => c.items?.some(p => p.name === 'probe-prompt'));
    expect(promptCall?.error).toBeNull();
    expect(promptCall?.items?.map(p => p.name)).toContain('probe-prompt');

    server.registerResource('probe', 'test://probe', {}, () => ({ contents: [] }));
    await waitUntil(() => resourceCalls.some(c => c.items?.some(r => r.uri === 'test://probe')));
    const resourceCall = resourceCalls.find(c => c.items?.some(r => r.uri === 'test://probe'));
    expect(resourceCall?.error).toBeNull();
    expect(resourceCall?.items?.map(r => r.uri)).toContain('test://probe');
});

verifies('client:list-changed:capability-gated', async ({ transport, protocolVersion }: TestArgs) => {
    const toolsCalls: unknown[] = [];
    const promptsCalls: unknown[] = [];
    const resourcesCalls: unknown[] = [];

    let server!: Server;
    const makeServer = () => {
        server = new Server({ name: 's', version: '0' }, { capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} } });
        server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
        server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
        return server;
    };

    const client = new Client(
        { name: 'c', version: '0' },
        {
            listChanged: {
                tools: { autoRefresh: false, debounceMs: 0, onChanged: (err, items) => toolsCalls.push({ err, items }) },
                prompts: {
                    autoRefresh: false,
                    debounceMs: 0,
                    onChanged: (err, items) => promptsCalls.push({ err, items })
                },
                resources: {
                    autoRefresh: false,
                    debounceMs: 0,
                    onChanged: (err, items) => resourcesCalls.push({ err, items })
                }
            }
        }
    );

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
    expect(caps?.prompts?.listChanged).toBeFalsy();
    expect(caps?.resources?.listChanged).toBeFalsy();

    toolsCalls.length = 0;
    promptsCalls.length = 0;
    resourcesCalls.length = 0;

    await server.sendToolListChanged();
    await server.sendPromptListChanged();
    await server.sendResourceListChanged();

    await waitUntil(() => toolsCalls.length >= 1);
    expect(toolsCalls[0]).toEqual({ err: null, items: null });

    await client.listTools();
    expect(promptsCalls).toHaveLength(0);
    expect(resourcesCalls).toHaveLength(0);
});

verifies('client:list-changed:signal-only', async ({ transport, protocolVersion }: TestArgs) => {
    const toolCalls: Array<{ error: Error | null; items: Tool[] | null }> = [];
    const promptCalls: Array<{ error: Error | null; items: Prompt[] | null }> = [];
    const resourceCalls: Array<{ error: Error | null; items: Resource[] | null }> = [];

    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        server.registerTool('seed', { inputSchema: z.object({}) }, () => ({ content: [] }));
        server.registerPrompt('seed', { description: '' }, () => ({ messages: [] }));
        server.registerResource('seed', 'test://seed', {}, () => ({ contents: [] }));
        return server;
    };

    const client = new Client(
        { name: 'c', version: '0' },
        {
            listChanged: {
                tools: { autoRefresh: false, debounceMs: 0, onChanged: (error, items) => toolCalls.push({ error, items }) },
                prompts: {
                    autoRefresh: false,
                    debounceMs: 0,
                    onChanged: (error, items) => promptCalls.push({ error, items })
                },
                resources: {
                    autoRefresh: false,
                    debounceMs: 0,
                    onChanged: (error, items) => resourceCalls.push({ error, items })
                }
            }
        }
    );

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const before = await client.listTools();

    toolCalls.length = 0;
    promptCalls.length = 0;
    resourceCalls.length = 0;

    server.registerTool('signal-only-tool', { inputSchema: z.object({}) }, () => ({ content: [] }));
    await waitUntil(() => toolCalls.length >= 1);
    expect(toolCalls[0]).toEqual({ error: null, items: null });

    server.registerPrompt('signal-only-prompt', { description: '' }, () => ({ messages: [] }));
    await waitUntil(() => promptCalls.length >= 1);
    expect(promptCalls[0]).toEqual({ error: null, items: null });

    server.registerResource('signal-only', 'test://signal-only', {}, () => ({ contents: [] }));
    await waitUntil(() => resourceCalls.length >= 1);
    expect(resourceCalls[0]).toEqual({ error: null, items: null });

    const after = await client.listTools();
    expect(after.tools.length).toBe(before.tools.length + 1);
});

verifies('mcpserver:handle:enable-disable', async ({ transport, protocolVersion }: TestArgs) => {
    let handle!: RegisteredTool;
    let server!: McpServer;

    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        handle = server.registerTool('toggle-probe', { inputSchema: z.object({}) }, () => ({
            content: [{ type: 'text', text: 'toggle-probe' }]
        }));
        return server;
    };

    let listChanged = 0;
    const client = newClient();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        listChanged++;
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    expect((await client.listTools()).tools.map(t => t.name)).toContain('toggle-probe');
    const baseline = await client.callTool({ name: 'toggle-probe', arguments: {} });
    expect(baseline.isError).toBeFalsy();
    expect(baseline.content).toEqual([{ type: 'text', text: 'toggle-probe' }]);

    const beforeDisable = listChanged;
    handle.disable();
    await waitUntil(() => listChanged > beforeDisable);

    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('toggle-probe');
    const disabledCall = await client.callTool({ name: 'toggle-probe', arguments: {} });
    expect(disabledCall.isError).toBe(true);
    expect(disabledCall.content).toEqual([{ type: 'text', text: expect.stringMatching(/disabled/i) }]);

    const beforeEnable = listChanged;
    handle.enable();
    await waitUntil(() => listChanged > beforeEnable);

    expect((await client.listTools()).tools.map(t => t.name)).toContain('toggle-probe');
    const restored = await client.callTool({ name: 'toggle-probe', arguments: {} });
    expect(restored.isError).toBeFalsy();
    expect(restored.content).toEqual([{ type: 'text', text: 'toggle-probe' }]);
});

verifies('mcpserver:list-changed:debounce', async ({ transport, protocolVersion }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer(
            { name: 's', version: '0' },
            {
                debouncedNotificationMethods: [
                    'notifications/tools/list_changed',
                    'notifications/resources/list_changed',
                    'notifications/prompts/list_changed'
                ]
            }
        );
        // Seed one of each so capability registration + request handlers are set
        // up pre-connect; post-connect registrations would otherwise try to
        // registerCapabilities and throw.
        server.registerTool('seed', { inputSchema: z.object({}) }, () => ({ content: [] }));
        server.registerResource('seed', 'test://seed', {}, () => ({ contents: [] }));
        server.registerPrompt('seed', { description: '' }, () => ({ messages: [] }));
        return server;
    };

    const counts = { tools: 0, resources: 0, prompts: 0 };
    const client = newClient();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void counts.tools++);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void counts.resources++);
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => void counts.prompts++);

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    counts.tools = 0;
    counts.resources = 0;
    counts.prompts = 0;

    server.registerTool('a', { inputSchema: z.object({}) }, () => ({ content: [] }));
    server.registerTool('b', { inputSchema: z.object({}) }, () => ({ content: [] }));
    server.registerTool('c', { inputSchema: z.object({}) }, () => ({ content: [] }));
    server.registerResource('a', 'test://debounce/a', {}, () => ({ contents: [] }));
    server.registerResource('b', 'test://debounce/b', {}, () => ({ contents: [] }));
    server.registerResource('c', 'test://debounce/c', {}, () => ({ contents: [] }));
    server.registerPrompt('a', { description: '' }, () => ({ messages: [] }));
    server.registerPrompt('b', { description: '' }, () => ({ messages: [] }));
    server.registerPrompt('c', { description: '' }, () => ({ messages: [] }));

    await waitUntil(() => counts.tools >= 1 && counts.resources >= 1 && counts.prompts >= 1);

    await client.listTools();
    expect(counts.tools).toBe(1);
    expect(counts.resources).toBe(1);
    expect(counts.prompts).toBe(1);

    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
});

verifies('mcpserver:register:post-connect', async ({ transport, protocolVersion }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' });
        // Seed so handlers + capabilities are wired pre-connect.
        server.registerTool('seed', { inputSchema: z.object({}) }, () => ({ content: [] }));
        server.registerResource('seed', 'test://seed', {}, () => ({ contents: [] }));
        server.registerPrompt('seed', { description: '' }, () => ({ messages: [] }));
        return server;
    };

    const seen: string[] = [];
    const client = newClient();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void seen.push('tools'));
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void seen.push('resources'));
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => void seen.push('prompts'));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    seen.length = 0;
    server.registerTool('post-connect-tool', { inputSchema: z.object({}) }, () => ({ content: [] }));
    await waitUntil(() => seen.includes('tools'));
    expect((await client.listTools()).tools.map(t => t.name)).toContain('post-connect-tool');

    seen.length = 0;
    server.registerResource('post-connect', 'test://post-connect', {}, () => ({ contents: [] }));
    await waitUntil(() => seen.includes('resources'));
    expect((await client.listResources()).resources.map(r => r.uri)).toContain('test://post-connect');

    seen.length = 0;
    server.registerPrompt('post-connect-prompt', { description: '' }, () => ({ messages: [] }));
    await waitUntil(() => seen.includes('prompts'));
    expect((await client.listPrompts()).prompts.map(p => p.name)).toContain('post-connect-prompt');
});

verifies('mcpserver:reach-through:set-request-handler', async ({ transport, protocolVersion }: TestArgs) => {
    const handlerHits: string[] = [];
    let server!: McpServer;

    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { resources: { subscribe: true, listChanged: true } } });
        server.registerResource('baseline', 'test://baseline', {}, () => ({ contents: [] }));
        server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return server;
    };

    const client = newClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    server.server.setRequestHandler(SubscribeRequestSchema, async request => {
        handlerHits.push(request.params.uri);
        return {};
    });

    await expect(client.subscribeResource({ uri: 'test://reach-through' })).resolves.toEqual({});
    await waitUntil(() => handlerHits.includes('test://reach-through'));
    expect(handlerHits).toEqual(['test://reach-through']);

    const echo = await client.callTool({ name: 'echo', arguments: { text: 'still wired' } });
    expect(echo.isError).toBeFalsy();
    expect(echo.content).toEqual([{ type: 'text', text: 'still wired' }]);
});
