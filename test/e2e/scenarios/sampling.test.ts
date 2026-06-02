/**
 * Self-contained test bodies for the sampling surface.
 *
 * Sampling is bidirectional: servers request LLM completions from clients by
 * sending `sampling/createMessage`. Each test builds its own server (via
 * factory) and client, wires them with {@link wire}, and asserts. Clients
 * declare the `sampling` capability and register a handler via
 * `setRequestHandler('sampling/createMessage', ...)`.
 */

import type { ClientCapabilities } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import { CreateMessageRequestParamsSchema } from '@modelcontextprotocol/core-internal';
import type { CreateMessageRequest, CreateMessageResultWithTools, ServerOptions } from '@modelcontextprotocol/server';
import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { tapWire, wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

/** Shape of the `structuredContent` returned by the `sampling-passthrough` test tool. */
type SamplingPassthroughResult = { ok: boolean; code?: number; message?: string };

const newClient = (capabilities?: ClientCapabilities) =>
    new Client({ name: 'c', version: '0' }, { capabilities: capabilities ?? { sampling: {} } });

function samplingServer() {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool('ask-llm', { inputSchema: z.object({ prompt: z.string() }) }, async ({ prompt }) => {
        const result = await s.server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
            maxTokens: 100
        });
        // Without tools in the request, createMessage returns a single content block.
        const text = result.content.type === 'text' ? result.content.text : '';
        return { content: [{ type: 'text', text: `model said: ${text}` }] };
    });
    return s;
}

function passthroughServer(options?: ServerOptions) {
    const s = new McpServer({ name: 's', version: '0' }, options);
    s.registerTool(
        'sampling-passthrough',
        {
            // The SDK's own params schema keeps the forwarded arguments fully typed without casts.
            inputSchema: CreateMessageRequestParamsSchema,
            outputSchema: z.object({
                ok: z.boolean(),
                result: z.unknown().optional(),
                code: z.number().optional(),
                message: z.string().optional()
            })
        },
        async args => {
            try {
                const result = await s.server.createMessage(args);
                return { structuredContent: { ok: true, result }, content: [{ type: 'text', text: JSON.stringify(result) }] };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const code = error instanceof ProtocolError ? error.code : undefined;
                return { structuredContent: { ok: false, code, message }, content: [{ type: 'text', text: message }] };
            }
        }
    );
    return s;
}

verifies('sampling:capability:declare', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient({ sampling: {} });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'stub', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, samplingServer, client);

    await client.callTool({ name: 'ask-llm', arguments: { prompt: 'hi' } });
    expect(received).toHaveLength(1);
});

verifies('sampling:create:basic', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'test-model', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'Paris' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [{ role: 'user', content: { type: 'text', text: 'capital?' } }], maxTokens: 50 }
    });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.params.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'capital?' } }]);
    expect(request?.params.maxTokens).toBe(50);

    expect(r.structuredContent).toEqual({
        ok: true,
        result: { role: 'assistant', content: { type: 'text', text: 'Paris' }, model: 'test-model', stopReason: 'endTurn' }
    });
});

verifies('sampling:create:include-context', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    for (const val of ['none', 'thisServer', 'allServers'] as const) {
        await client.callTool({ name: 'sampling-passthrough', arguments: { messages: [], maxTokens: 10, includeContext: val } });
    }
    await client.callTool({ name: 'sampling-passthrough', arguments: { messages: [], maxTokens: 10 } });

    expect(received).toHaveLength(4);
    expect(received.map(r => r.params.includeContext)).toEqual(['none', 'thisServer', 'allServers', undefined]);
});

verifies('sampling:create:model-preferences', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const prefs = { hints: [{ name: 'sonnet' }], costPriority: 0.3, speedPriority: 0.7, intelligencePriority: 0.5 };
    await client.callTool({ name: 'sampling-passthrough', arguments: { messages: [], maxTokens: 10, modelPreferences: prefs } });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.params.modelPreferences).toEqual(prefs);
});

verifies('sampling:create:system-prompt', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    await client.callTool({ name: 'sampling-passthrough', arguments: { messages: [], maxTokens: 10, systemPrompt: 'Be helpful' } });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.params.systemPrompt).toBe('Be helpful');
});

verifies('sampling:create:tools', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient({ sampling: { tools: {} } });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        const mode = req.params.toolChoice?.mode;
        if (mode === 'auto' || mode === 'required') {
            return {
                model: 'm',
                role: 'assistant',
                stopReason: 'toolUse',
                content: [{ type: 'tool_use', id: 'c1', name: 'weather', input: { city: 'SF' } }]
            } satisfies CreateMessageResultWithTools;
        }
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'sunny' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const tools = [
        { name: 'weather', description: 'Get weather', inputSchema: { type: 'object' as const, properties: { city: { type: 'string' } } } }
    ];

    for (const mode of ['auto', 'required', 'none'] as const) {
        await client.callTool({ name: 'sampling-passthrough', arguments: { messages: [], maxTokens: 10, tools, toolChoice: { mode } } });
    }

    expect(received).toHaveLength(3);
    expect(received.map(r => r.params.tools?.map(t => t.name))).toEqual([['weather'], ['weather'], ['weather']]);
    expect(received.map(r => r.params.toolChoice?.mode)).toEqual(['auto', 'required', 'none']);
});

verifies('sampling:error:user-rejected', async ({ transport }: TestArgs) => {
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async () => {
        throw new ProtocolError(-1, 'User rejected sampling request');
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool<SamplingPassthroughResult>({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10 }
    });

    expect(r.structuredContent).toMatchObject({ ok: false, code: -1 });
    expect((r.structuredContent as { message?: unknown }).message).toMatch(/User rejected sampling request/);
});

verifies('sampling:message:content-cardinality', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, samplingServer, client);

    await client.callTool({ name: 'ask-llm', arguments: { prompt: 'one' } });

    expect(received).toHaveLength(1);
    const singleMessage = received[0]?.params.messages[0];
    expect(Array.isArray(singleMessage?.content)).toBe(false);
    expect(singleMessage?.content).toEqual({ type: 'text', text: 'one' });

    received.length = 0;
    const client2 = newClient();
    client2.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    // Inner block scopes the second connection's `await using` binding.
    {
        await using _ = await wire(transport, passthroughServer, client2);

        await client2.callTool({
            name: 'sampling-passthrough',
            arguments: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'a' },
                            { type: 'text', text: 'b' }
                        ]
                    }
                ],
                maxTokens: 10
            }
        });

        expect(received).toHaveLength(1);
        const arrayMessage = received[0]?.params.messages[0];
        expect(Array.isArray(arrayMessage?.content)).toBe(true);
        expect(arrayMessage?.content).toEqual([
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' }
        ]);
    }
});

verifies('sampling:result:no-tools-single-content', async ({ transport }: TestArgs) => {
    const client = newClient();
    // No tools/toolChoice in the request, so the client's wrapped sampling handler validates against CreateMessageResultSchema and rejects array content with -32602.
    client.setRequestHandler('sampling/createMessage', async () => ({
        model: 'm',
        role: 'assistant',
        stopReason: 'endTurn',
        content: [{ type: 'text', text: 'array-content' }]
    }));

    await using _ = await wire(transport, samplingServer, client);

    const r = await client.callTool({ name: 'ask-llm', arguments: { prompt: 'hi' } });

    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: expect.stringContaining('Invalid sampling result') }]);
    // The handler's text must never reach the tool result: the client rejects before any sampling result is returned.
    const [block] = r.content;
    if (block?.type !== 'text') throw new Error('expected a text content block');
    expect(block.text).not.toContain('array-content');
});

verifies('sampling:result:with-tools-array-content', async ({ transport }: TestArgs) => {
    const client = newClient({ sampling: { tools: {} } });
    client.setRequestHandler('sampling/createMessage', async () => {
        return {
            model: 'm',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [
                { type: 'text', text: 'using' },
                { type: 'tool_use', id: 'c1', name: 'noop', input: {} }
            ]
        } satisfies CreateMessageResultWithTools;
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, tools: [{ name: 'noop', inputSchema: { type: 'object' as const } }] }
    });

    expect(r.structuredContent).toMatchObject({
        ok: true,
        result: {
            stopReason: 'toolUse',
            content: [
                { type: 'text', text: 'using' },
                { type: 'tool_use', id: 'c1', name: 'noop', input: {} }
            ]
        }
    });
});

verifies('sampling:tool-result:no-mixed-content', async ({ transport }: TestArgs) => {
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async () => {
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'unreachable' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool<SamplingPassthroughResult>({
        name: 'sampling-passthrough',
        arguments: {
            messages: [
                { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'n', input: {} }] },
                {
                    role: 'user',
                    content: [
                        { type: 'tool_result', toolUseId: 'c1', content: [] },
                        { type: 'text', text: 'mixed' }
                    ]
                }
            ],
            maxTokens: 10
        }
    });

    expect(r.structuredContent).toMatchObject({ ok: false, code: ProtocolErrorCode.InvalidParams });
    expect((r.structuredContent as { message?: unknown }).message).toMatch(/tool.?result/i);
});

verifies('sampling:tool-use:result-balance', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient({ sampling: { tools: {} } });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const tools = [{ name: 'weather', inputSchema: { type: 'object' as const } }];

    const balanced = await client.callTool({
        name: 'sampling-passthrough',
        arguments: {
            messages: [
                { role: 'user', content: { type: 'text', text: 'hi' } },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'weather', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: [] }] }
            ],
            tools,
            maxTokens: 10
        }
    });

    expect(balanced.structuredContent).toMatchObject({ ok: true });
    expect(received).toHaveLength(1);

    const missing = await client.callTool({
        name: 'sampling-passthrough',
        arguments: {
            messages: [
                { role: 'user', content: { type: 'text', text: 'hi' } },
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'a', name: 'weather', input: {} },
                        { type: 'tool_use', id: 'b', name: 'weather', input: {} }
                    ]
                },
                { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: [] }] }
            ],
            tools,
            maxTokens: 10
        }
    });

    expect(missing.structuredContent).toMatchObject({ ok: false, code: ProtocolErrorCode.InvalidParams });
    expect(received).toHaveLength(1);

    const trailing = await client.callTool({
        name: 'sampling-passthrough',
        arguments: {
            messages: [
                { role: 'user', content: { type: 'text', text: 'hi' } },
                { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'weather', input: {} }] }
            ],
            tools,
            maxTokens: 10
        }
    });

    expect(trailing.structuredContent).toMatchObject({ ok: false, code: ProtocolErrorCode.InvalidParams });
    expect(received).toHaveLength(1);
});

verifies('sampling:tools:server-gated-by-capability', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient({ sampling: {} });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'unreachable' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const withTools = await client.callTool<SamplingPassthroughResult>({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, tools: [{ name: 'n', inputSchema: { type: 'object' as const } }] }
    });

    expect(withTools.structuredContent).toMatchObject({ ok: false });
    expect((withTools.structuredContent as { message?: unknown }).message).toMatch(/sampling.*tools/i);
    expect(received).toHaveLength(0);

    const withChoice = await client.callTool<SamplingPassthroughResult>({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, toolChoice: { mode: 'auto' } }
    });

    expect(withChoice.structuredContent).toMatchObject({ ok: false });
    expect((withChoice.structuredContent as { message?: unknown }).message).toMatch(/sampling.*tools/i);
    expect(received).toHaveLength(0);

    const empty = await client.callTool<SamplingPassthroughResult>({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, tools: [], toolChoice: { mode: 'required' } }
    });

    expect(empty.structuredContent).toMatchObject({ ok: false });
    expect((empty.structuredContent as { message?: unknown }).message).toMatch(/sampling.*tools/i);
    expect(received).toHaveLength(0);
});

verifies('sampling:create:image-content', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return {
            model: 'mock-vision-1',
            role: 'assistant',
            stopReason: 'endTurn',
            content: { type: 'image', data: 'Y2F0', mimeType: 'image/png' }
        };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool({
        name: 'sampling-passthrough',
        arguments: {
            messages: [{ role: 'user', content: { type: 'image', data: 'aW1n', mimeType: 'image/jpeg' } }],
            maxTokens: 100
        }
    });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.params.messages).toEqual([{ role: 'user', content: { type: 'image', data: 'aW1n', mimeType: 'image/jpeg' } }]);
    expect(request?.params.maxTokens).toBe(100);

    expect(r.structuredContent).toEqual({
        ok: true,
        result: {
            role: 'assistant',
            content: { type: 'image', data: 'Y2F0', mimeType: 'image/png' },
            model: 'mock-vision-1',
            stopReason: 'endTurn'
        }
    });
});

verifies('sampling:create:audio-content', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    const client = newClient();
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return {
            model: 'mock-audio-1',
            role: 'assistant',
            stopReason: 'endTurn',
            content: { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' }
        };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const r = await client.callTool({
        name: 'sampling-passthrough',
        arguments: {
            messages: [{ role: 'user', content: { type: 'audio', data: 'c25k', mimeType: 'audio/mpeg' } }],
            maxTokens: 100
        }
    });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.params.messages).toEqual([{ role: 'user', content: { type: 'audio', data: 'c25k', mimeType: 'audio/mpeg' } }]);
    expect(request?.params.maxTokens).toBe(100);

    expect(r.structuredContent).toEqual({
        ok: true,
        result: {
            role: 'assistant',
            content: { type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav' },
            model: 'mock-audio-1',
            stopReason: 'endTurn'
        }
    });
});

verifies('sampling:context:server-gated-by-capability', async ({ transport }: TestArgs) => {
    const received: CreateMessageRequest[] = [];
    // Client declares plain sampling but not the sampling.context sub-capability.
    const client = newClient({ sampling: {} });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'm', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
    });

    await using _ = await wire(transport, passthroughServer, client);

    const none = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, includeContext: 'none' }
    });

    expect(none.structuredContent).toMatchObject({ ok: true });
    expect(received).toHaveLength(1);

    const thisServer = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, includeContext: 'thisServer' }
    });

    expect(thisServer.structuredContent).toMatchObject({ ok: false, message: expect.stringMatching(/context/i) });
    expect(received).toHaveLength(1);

    const allServers = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [], maxTokens: 10, includeContext: 'allServers' }
    });

    expect(allServers.structuredContent).toMatchObject({ ok: false, message: expect.stringMatching(/context/i) });
    expect(received).toHaveLength(1);
});

verifies('sampling:create:not-supported', async ({ transport }: TestArgs) => {
    // Client declares no sampling capability at all and registers no sampling handler.
    const client = newClient({});

    await using _ = await wire(transport, () => passthroughServer({ enforceStrictCapabilities: true }), client);
    const tap = tapWire(client);

    const r = await client.callTool({
        name: 'sampling-passthrough',
        arguments: { messages: [{ role: 'user', content: { type: 'text', text: 'Say hello.' } }], maxTokens: 100 }
    });

    expect(r.structuredContent).toMatchObject({ ok: false, message: expect.stringMatching(/does not support sampling/i) });
    // The refusal happens server-side: no sampling/createMessage request ever reaches the client.
    expect(tap.received.filter(m => 'method' in m && m.method === 'sampling/createMessage')).toEqual([]);
});
