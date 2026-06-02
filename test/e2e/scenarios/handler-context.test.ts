/**
 * Self-contained test bodies for the ServerContext conveniences handed to
 * request handlers: `ctx.mcpReq.log()`, `ctx.mcpReq.elicitInput()`,
 * `ctx.mcpReq.requestSampling()`, the per-request envelope facts
 * (`ctx.mcpReq.protocolVersion`, `ctx.client.*`), and — under HTTP hosting —
 * `ctx.http.req` exposing the incoming request's Fetch Headers.
 *
 * Each body builds its own server (via factory) and client, wires them with
 * {@link wire} (or hosts directly with {@link hostPerSession} where the HTTP
 * hosting layer is itself the subject), and asserts.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
    ClientCapabilities,
    CreateMessageRequest,
    ElicitRequest,
    ElicitRequestFormParams,
    Implementation,
    LoggingLevel
} from '@modelcontextprotocol/server';
import { LATEST_PROTOCOL_VERSION, McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** A supported protocol version other than the latest, used to prove the version reported is the negotiated one. */
const OLDER_SUPPORTED_VERSION = (() => {
    const older = SUPPORTED_PROTOCOL_VERSIONS.find(v => v !== LATEST_PROTOCOL_VERSION);
    if (older === undefined) throw new Error('expected SUPPORTED_PROTOCOL_VERSIONS to include a version other than the latest');
    return older;
})();

verifies('mcpserver:context:log-from-handler', async ({ transport }: TestArgs) => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>(resolve => {
        releaseHandler = resolve;
    });

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('emit-log', { inputSchema: z.object({}) }, async (_args, ctx) => {
            await ctx.mcpReq.log('info', { msg: 'from-handler' }, 'handler-logger');
            // Hold the tool call open until the test has observed the notification, so receipt provably happens mid-call.
            await handlerGate;
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return s;
    };

    const logs: Array<{ level: LoggingLevel; logger?: string; data: unknown }> = [];
    const client = new Client({ name: 'c', version: '0' });
    client.setNotificationHandler('notifications/message', n => {
        logs.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    const inFlightCall = client.callTool({ name: 'emit-log', arguments: {} });
    try {
        // The handler is parked on the gate, so the tools/call request is still in flight when the log arrives.
        await vi.waitFor(() => expect(logs).toHaveLength(1));
        expect(logs).toEqual([{ level: 'info', logger: 'handler-logger', data: { msg: 'from-handler' } }]);
    } finally {
        releaseHandler();
    }

    const result = await inFlightCall;
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
});

verifies('mcpserver:context:elicit-from-handler', async ({ transport }: TestArgs) => {
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        type: 'object',
        properties: { color: { type: 'string' } },
        required: ['color']
    };

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-color', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const ans = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Favorite color?', requestedSchema });
            const color = ans.action === 'accept' ? String(ans.content?.color) : '<none>';
            return { content: [{ type: 'text', text: `${ans.action}:${color}` }] };
        });
        return s;
    };

    const received: ElicitRequest['params'][] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req.params);
        return { action: 'accept', content: { color: 'teal' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'ask-color', arguments: {} });

    expect(received).toEqual([{ mode: 'form', message: 'Favorite color?', requestedSchema }]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'accept:teal' }]);
});

verifies('mcpserver:context:sampling-from-handler', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('summarize', { inputSchema: z.object({ topic: z.string() }) }, async ({ topic }, ctx) => {
            const result = await ctx.mcpReq.requestSampling({
                messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
                maxTokens: 50
            });
            // Without tools in the request the stub client returns a single text block; arrays would mean a tool-use flow.
            const text = !Array.isArray(result.content) && result.content.type === 'text' ? result.content.text : '<unexpected>';
            return { content: [{ type: 'text', text: `${result.model}|${result.role}|${text}` }] };
        });
        return s;
    };

    const received: CreateMessageRequest[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    client.setRequestHandler('sampling/createMessage', async req => {
        received.push(req);
        return { model: 'stub-model', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'a short summary' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'summarize', arguments: { topic: 'mcp' } });

    expect(received).toHaveLength(1);
    const samplingRequest = received[0];
    if (samplingRequest === undefined) throw new Error('expected exactly one sampling request');
    expect(samplingRequest.method).toBe('sampling/createMessage');
    expect(samplingRequest.params.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Summarize mcp' } }]);
    expect(samplingRequest.params.maxTokens).toBe(50);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'stub-model|assistant|a short summary' }]);
});

verifies('hosting:context:web-request-headers', async (_args: TestArgs) => {
    const PROBE_HEADER = 'x-e2e-probe';
    const PROBE_VALUE = 'probe-7d1f';

    const seenByTool: Array<{ isFetchHeaders: boolean; probe: string | null }> = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('read-probe-header', { inputSchema: z.object({}) }, (_toolArgs, ctx) => {
            const headers = ctx.http?.req?.headers;
            seenByTool.push({
                isFetchHeaders: headers instanceof Headers,
                probe: headers instanceof Headers ? headers.get(PROBE_HEADER) : null
            });
            return { content: [{ type: 'text', text: headers?.get(PROBE_HEADER) ?? '<missing>' }] };
        });
        return s;
    });

    const client = new Client({ name: 'c', version: '0' });
    const httpTransport = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
        fetch: (url, init) => mcpHost.handleRequest(new Request(url, init)),
        requestInit: { headers: { [PROBE_HEADER]: PROBE_VALUE } }
    });

    try {
        await client.connect(httpTransport);
        const result = await client.callTool({ name: 'read-probe-header', arguments: {} });

        // The custom header set on the client transport is readable as Fetch Headers inside the handler.
        expect(seenByTool).toEqual([{ isFetchHeaders: true, probe: PROBE_VALUE }]);
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: PROBE_VALUE }]);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies(
    'protocol:envelope:ctx-version-readable',
    async ({ transport }: TestArgs) => {
        let seenVersion: string | undefined;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('read-version', { inputSchema: z.object({}) }, (_args, ctx) => {
                seenVersion = ctx.mcpReq.protocolVersion;
                return { content: [{ type: 'text', text: ctx.mcpReq.protocolVersion }] };
            });
            return s;
        };
        const client = new Client({ name: 'c', version: '0' });

        await using _ = await wire(transport, makeServer, client);
        const result = await client.callTool({ name: 'read-version', arguments: {} });

        // On a 2025 connection the governing version is the one negotiated at initialize.
        expect(seenVersion).toBe(client.getNegotiatedProtocolVersion());
        expect(result.content).toEqual([{ type: 'text', text: client.getNegotiatedProtocolVersion() }]);
    },
    { title: 'server handler reads negotiated version (default)' }
);

verifies(
    'protocol:envelope:ctx-version-readable',
    async ({ transport }: TestArgs) => {
        let seenVersion: string | undefined;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('read-version', { inputSchema: z.object({}) }, (_args, ctx) => {
                seenVersion = ctx.mcpReq.protocolVersion;
                return { content: [{ type: 'text', text: ctx.mcpReq.protocolVersion }] };
            });
            return s;
        };
        // Pin the client to an older supported version so the governing version differs from the latest,
        // proving the handler reads the actually-negotiated version rather than a constant.
        const client = new Client({ name: 'c', version: '0' }, { supportedProtocolVersions: [OLDER_SUPPORTED_VERSION] });

        await using _ = await wire(transport, makeServer, client);
        await client.callTool({ name: 'read-version', arguments: {} });

        expect(seenVersion).toBe(OLDER_SUPPORTED_VERSION);
        expect(client.getNegotiatedProtocolVersion()).toBe(OLDER_SUPPORTED_VERSION);
    },
    { title: 'server handler reads negotiated version (pinned older)' }
);

verifies(
    'protocol:envelope:ctx-version-readable',
    async ({ transport }: TestArgs) => {
        // BaseContext is shared by both roles: a client-side handler can read the governing version too.
        let seenByClientHandler: string | undefined;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
                const r = await ctx.mcpReq.requestSampling({
                    messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
                    maxTokens: 10
                });
                const text = !Array.isArray(r.content) && r.content.type === 'text' ? r.content.text : '<unexpected>';
                return { content: [{ type: 'text', text }] };
            });
            return s;
        };
        const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
        client.setRequestHandler('sampling/createMessage', async (_req, ctx) => {
            seenByClientHandler = ctx.mcpReq.protocolVersion;
            return { model: 'stub', role: 'assistant', stopReason: 'endTurn', content: { type: 'text', text: 'ok' } };
        });

        await using _ = await wire(transport, makeServer, client);
        await client.callTool({ name: 'ask', arguments: {} });

        expect(seenByClientHandler).toBe(client.getNegotiatedProtocolVersion());
    },
    { title: 'client handler reads governing version' }
);

verifies(
    'protocol:envelope:ctx-capabilities-readable',
    async ({ transport }: TestArgs) => {
        let seen: { capabilities: ClientCapabilities; info: Implementation | undefined } | undefined;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('read-client', { inputSchema: z.object({}) }, (_args, ctx) => {
                seen = { capabilities: ctx.client.capabilities, info: ctx.client.info };
                return { content: [{ type: 'text', text: 'ok' }] };
            });
            return s;
        };
        const declared: ClientCapabilities = { sampling: {}, roots: { listChanged: true } };
        const clientInfo: Implementation = { name: 'declaring-client', version: '4.5.6' };
        const client = new Client(clientInfo, { capabilities: declared });

        await using _ = await wire(transport, makeServer, client);
        await client.callTool({ name: 'read-client', arguments: {} });

        // The handler sees exactly what the client declared at initialize.
        expect(seen?.capabilities.sampling).toEqual({});
        expect(seen?.capabilities.roots).toEqual({ listChanged: true });
        expect(seen?.info).toEqual(clientInfo);
    },
    { title: 'declared capabilities and info' }
);

verifies(
    'protocol:envelope:ctx-capabilities-readable',
    async ({ transport }: TestArgs) => {
        let seen: { capabilities: ClientCapabilities; info: Implementation | undefined } | undefined;
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('read-client', { inputSchema: z.object({}) }, (_args, ctx) => {
                seen = { capabilities: ctx.client.capabilities, info: ctx.client.info };
                return { content: [{ type: 'text', text: 'ok' }] };
            });
            return s;
        };
        // A client that declares no optional capabilities yields a `{}`-shaped object, not undefined.
        const clientInfo: Implementation = { name: 'bare-client', version: '0.0.1' };
        const client = new Client(clientInfo);

        await using _ = await wire(transport, makeServer, client);
        await client.callTool({ name: 'read-client', arguments: {} });

        expect(seen?.capabilities).toEqual({});
        expect(seen?.info).toEqual(clientInfo);
    },
    { title: 'no optional capabilities yields {} shape' }
);
