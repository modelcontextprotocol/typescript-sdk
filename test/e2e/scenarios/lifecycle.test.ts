/**
 * Self-contained test bodies for the lifecycle surface.
 *
 * Lifecycle tests cover the initialize handshake, version negotiation,
 * the `notifications/initialized` ordering rule, ping, and the metadata
 * accessors on both ends (`getServerVersion`/`getServerCapabilities` on the
 * client, `getClientVersion`/`getClientCapabilities` on the server). Each
 * export is a {@link TestCase}: it builds its own server (via a factory),
 * builds its own client, wires them with {@link wire}, and asserts. Function
 * names mirror the requirement id in camelCase.
 */

import { expect } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    type ClientCapabilities,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    type Implementation,
    type InitializeRequest,
    InitializeRequestSchema,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    type JSONRPCMessage,
    LATEST_PROTOCOL_VERSION,
    ListRootsRequestSchema,
    type ServerCapabilities,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../../../src/types.js';

import { tapWire, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const OLDER_SUPPORTED_VERSION = SUPPORTED_PROTOCOL_VERSIONS.find(v => v !== LATEST_PROTOCOL_VERSION)!;
const BOGUS_VERSION = '1999-01-01';

const DEFAULT_INSTRUCTIONS = 'This is the default server instruction set for lifecycle tests.';

function minimalClient() {
    return new Client({ name: 'minimal-client', version: '0.0.0' });
}

function minimalServer(): McpServer {
    return new McpServer({ name: 'minimal-server', version: '0.0.0' });
}

/**
 * Raw `Server` whose initialize handler echoes the inbound request to
 * `received` and replies with the given `protocolVersion`. Used by the
 * version-negotiation tests so both sides of the handshake are observable
 * via public API only.
 */
function recordingInitServer(replyVersion: string, received: InitializeRequest['params'][]): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: {} });
    s.setRequestHandler(InitializeRequestSchema, async req => {
        received.push(req.params);
        return { protocolVersion: replyVersion, capabilities: {}, serverInfo: { name: 's', version: '0' } };
    });
    return s;
}

interface HandshakeLogEntry {
    direction: 'client-to-server' | 'server-to-client';
    message: JSONRPCMessage;
}

/**
 * Patch `client.connect` so the transport `wire()` hands it is tapped from the
 * very first handshake message — `tapWire()` can only attach after connect, too
 * late to observe initialize. `rewriteOutbound` lets a test alter client→server
 * messages before they reach the wire (e.g. to request a protocol version the
 * SDK client would never ask for itself).
 */
function tapHandshake(client: Client, rewriteOutbound?: (message: JSONRPCMessage) => JSONRPCMessage): HandshakeLogEntry[] {
    const log: HandshakeLogEntry[] = [];
    const originalConnect = client.connect.bind(client);
    client.connect = (clientTransport, options) => {
        const originalSend = clientTransport.send.bind(clientTransport);
        clientTransport.send = (message, sendOptions) => {
            const outbound = rewriteOutbound ? rewriteOutbound(message) : message;
            log.push({ direction: 'client-to-server', message: outbound });
            return originalSend(outbound, sendOptions);
        };
        // Protocol.connect chains a pre-set onmessage, so inbound messages are logged before the client reacts to them.
        clientTransport.onmessage = message => {
            log.push({ direction: 'server-to-client', message });
        };
        return originalConnect(clientTransport, options);
    };
    return log;
}

verifies('lifecycle:initialize:basic', async ({ transport }: TestArgs) => {
    const SERVER_CAPS: ServerCapabilities = { tools: { listChanged: true }, logging: {} };

    const initReqs: InitializeRequest['params'][] = [];
    const makeServer = () => {
        const s = new Server({ name: 'lifecycle-server', version: '1.2.3' }, { capabilities: SERVER_CAPS });
        s.setRequestHandler(InitializeRequestSchema, async req => {
            initReqs.push(req.params);
            return {
                protocolVersion: req.params.protocolVersion,
                capabilities: SERVER_CAPS,
                serverInfo: { name: 'lifecycle-server', version: '1.2.3' }
            };
        });
        return s;
    };
    const client = new Client({ name: 'lifecycle-client', version: '0.0.0' }, { capabilities: { roots: {} } });

    await using _ = await wire(transport, makeServer, client);

    // Server saw an InitializeRequest with all spec-mandated fields populated.
    expect(initReqs).toHaveLength(1);
    expect(initReqs[0].protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(initReqs[0].clientInfo).toEqual({ name: 'lifecycle-client', version: '0.0.0' });
    expect(initReqs[0].capabilities).toEqual({ roots: {} });

    // Client surfaces what the server returned.
    expect(client.getServerVersion()).toEqual({ name: 'lifecycle-server', version: '1.2.3' });
    expect(client.getServerCapabilities()).toEqual(SERVER_CAPS);
});

verifies('lifecycle:initialize:instructions', async ({ transport }: TestArgs) => {
    const makeServer = () => new McpServer({ name: 's', version: '0' }, { instructions: DEFAULT_INSTRUCTIONS });
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);

    expect(client.getInstructions()).toBe(DEFAULT_INSTRUCTIONS);
});

verifies('lifecycle:initialized-notification', async ({ transport }: TestArgs) => {
    const order: string[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.server.oninitialized = () => order.push('initialized');
        s.registerTool('marker', { inputSchema: z.object({}) }, () => {
            order.push('request');
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);
    expect(order).toContain('initialized');

    await client.callTool({ name: 'marker', arguments: {} });

    // Wherever a request arrived, the immediately-preceding event in the
    // server-side order log is the initialized hook firing — i.e., the client
    // sent notifications/initialized before any other request.
    const reqIdx = order.indexOf('request');
    expect(reqIdx).toBeGreaterThan(0);
    expect(order[reqIdx - 1]).toBe('initialized');
});

verifies('lifecycle:pre-initialization-ordering', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 'weather-server', version: '1.0.0' });
        s.registerTool('get_weather', { inputSchema: z.object({ city: z.string() }) }, ({ city }) => ({
            content: [{ type: 'text', text: `Sunny in ${city}` }]
        }));
        return s;
    };
    const client = minimalClient();
    const log = tapHandshake(client);

    await using _ = await wire(transport, makeServer, client);

    const result = await client.callTool({ name: 'get_weather', arguments: { city: 'Berlin' } });
    expect(result.content).toEqual([{ type: 'text', text: 'Sunny in Berlin' }]);

    const requestMethods = new Map<string | number, string>();
    const summary = log.map(({ direction, message }) => {
        if (isJSONRPCRequest(message)) {
            requestMethods.set(message.id, message.method);
            return `${direction} request ${message.method}`;
        }
        if (isJSONRPCNotification(message)) return `${direction} notification ${message.method}`;
        if (isJSONRPCResultResponse(message)) return `${direction} result for ${requestMethods.get(message.id) ?? 'unknown request'}`;
        return `${direction} error response`;
    });

    // Before initialization completes the client sends only initialize and the server only its result; the first feature request follows notifications/initialized.
    expect(summary).toEqual([
        'client-to-server request initialize',
        'server-to-client result for initialize',
        'client-to-server notification notifications/initialized',
        'client-to-server request tools/call',
        'server-to-client result for tools/call'
    ]);
});

verifies('lifecycle:ping', async ({ transport }: TestArgs) => {
    const client = minimalClient();
    await using _ = await wire(transport, minimalServer, client);

    const tap = tapWire(client);
    const result = await client.ping();
    expect(result).toEqual({});

    const req = tap.sent.find(m => isJSONRPCRequest(m) && m.method === 'ping');
    expect(req).toBeDefined();
    if (!req || !isJSONRPCRequest(req)) throw new Error('expected ping request');

    const res = tap.received.find(m => isJSONRPCResultResponse(m) && m.id === req.id);
    if (!res || !isJSONRPCResultResponse(res)) throw new Error('expected ping result');
    expect(res.result).toEqual({});
});

verifies('lifecycle:version:match', async ({ transport }: TestArgs) => {
    const initReqs: InitializeRequest['params'][] = [];
    const makeServer = () => recordingInitServer(LATEST_PROTOCOL_VERSION, initReqs);
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);

    expect(initReqs).toHaveLength(1);
    expect(initReqs[0].protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    // Connect succeeded at the matched version: server state is populated.
    expect(client.getServerCapabilities()).toEqual({});
    expect(client.getServerVersion()).toEqual({ name: 's', version: '0' });
});

verifies('lifecycle:version:downgrade', async ({ transport }: TestArgs) => {
    const initReqs: InitializeRequest['params'][] = [];
    const makeServer = () => recordingInitServer(OLDER_SUPPORTED_VERSION, initReqs);
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);

    // Client requested LATEST; server replied with an older supported version;
    // connect resolved (no throw) and server state is populated, so the client
    // accepted the downgrade. There is no transport-agnostic SDK getter for the
    // negotiated version (`client.transport.protocolVersion` is HTTP-only).
    expect(initReqs).toHaveLength(1);
    expect(initReqs[0].protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(OLDER_SUPPORTED_VERSION).not.toBe(LATEST_PROTOCOL_VERSION);
    expect(client.getServerCapabilities()).toEqual({});
    expect(client.getServerVersion()).toEqual({ name: 's', version: '0' });
});

verifies('lifecycle:version:server-fallback-latest', async ({ transport }: TestArgs) => {
    const client = minimalClient();
    // The SDK client only ever requests the latest version, so the unsupported version is injected into the outbound initialize; the server runs the SDK's default initialize handler.
    const log = tapHandshake(client, message =>
        isJSONRPCRequest(message) && message.method === 'initialize'
            ? { ...message, params: { ...message.params, protocolVersion: BOGUS_VERSION } }
            : message
    );

    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(BOGUS_VERSION);

    await using _ = await wire(transport, minimalServer, client);

    const initRequest = log.find(
        e => e.direction === 'client-to-server' && isJSONRPCRequest(e.message) && e.message.method === 'initialize'
    );
    if (!initRequest || !isJSONRPCRequest(initRequest.message)) throw new Error('expected an initialize request on the wire');
    expect(initRequest.message.params?.protocolVersion).toBe(BOGUS_VERSION);
    const initRequestId = initRequest.message.id;

    const initResponse = log.find(
        e => e.direction === 'server-to-client' && isJSONRPCResultResponse(e.message) && e.message.id === initRequestId
    );
    if (!initResponse || !isJSONRPCResultResponse(initResponse.message)) throw new Error('expected a result for the initialize request');
    expect(initResponse.message.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

    // The client accepted the fallback version: initialization completed and server state is populated.
    expect(client.getServerVersion()).toEqual({ name: 'minimal-server', version: '0.0.0' });
    expect(client.getServerCapabilities()).toEqual({});
});

verifies('lifecycle:version:reject-unsupported', async ({ transport }: TestArgs) => {
    const initReqs: InitializeRequest['params'][] = [];
    const makeServer = () => recordingInitServer(BOGUS_VERSION, initReqs);
    const client = minimalClient();

    await expect(wire(transport, makeServer, client)).rejects.toThrow(/protocol version.*not supported|1999-01-01/i);

    expect(client.transport).toBeUndefined();
    expect(client.getServerCapabilities()).toBeUndefined();
    expect(client.getServerVersion()).toBeUndefined();
});

verifies('lifecycle:capability:client-not-declared', async ({ transport }: TestArgs) => {
    let observedCaps: ClientCapabilities | undefined;
    const makeServer = () => {
        const s = minimalServer();
        s.server.oninitialized = () => {
            observedCaps = s.server.getClientCapabilities();
        };
        return s;
    };
    const client = new Client({ name: 'no-caps-client', version: '0.0.0' }, { capabilities: {} });

    await using _ = await wire(transport, makeServer, client);

    // Client side: cannot send notifications / register handlers for undeclared caps.
    await expect(client.sendRootsListChanged()).rejects.toThrow(/roots.*list.?changed/i);
    expect(() =>
        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            role: 'assistant',
            content: { type: 'text', text: 'unreachable' },
            model: 'stub'
        }))
    ).toThrow(/sampling/i);
    expect(() => client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }))).toThrow(/elicitation/i);
    expect(() => client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [] }))).toThrow(/roots/i);

    // Server side: it sees the empty client capabilities. (Server-side request
    // gating on these is opt-in via `enforceStrictCapabilities` and is covered
    // by the elicitation/sampling capability tests, not here.)
    expect(observedCaps).toEqual({});
});

verifies('lifecycle:capability:server-not-advertised', async ({ transport }: TestArgs) => {
    const makeServer = () => new McpServer({ name: 's', version: '0' }, { capabilities: {} });
    const client = new Client({ name: 'c', version: '0' }, { enforceStrictCapabilities: true });

    await using _ = await wire(transport, makeServer, client);

    const caps = client.getServerCapabilities();
    expect(caps).toEqual({});

    const calls: Array<[string, () => Promise<unknown>]> = [
        ['tools', () => client.listTools()],
        ['resources', () => client.listResources()],
        ['resources', () => client.listResourceTemplates()],
        ['prompts', () => client.listPrompts()],
        ['logging', () => client.setLoggingLevel('debug')],
        ['completions', () => client.complete({ ref: { type: 'ref/prompt', name: 'x' }, argument: { name: 'a', value: '' } })]
    ];
    for (const [cap, call] of calls) {
        await expect(call(), `${cap} should be gated`).rejects.toThrow(new RegExp(cap, 'i'));
    }
});

verifies('lifecycle:initialize:capabilities:minimal', async ({ transport }: TestArgs) => {
    // Bare McpServer: no feature handlers registered and no capabilities option passed.
    const client = minimalClient();

    await using _ = await wire(transport, minimalServer, client);

    // Exactly empty: no tools, resources, prompts, completions, or logging advertised.
    expect(client.getServerCapabilities()).toEqual({});
});

verifies('lifecycle:capability:experimental-passthrough', async ({ transport }: TestArgs) => {
    const SERVER_EXPERIMENTAL = {
        'x-vendor/streaming': { version: 2, modes: ['delta', 'full'] },
        'org.example.preview': { nested: { limit: 42 }, enabled: true }
    };
    const CLIENT_EXPERIMENTAL = {
        'x-vendor/telemetry': { level: 'debug', sinks: ['stdout'] }
    };

    let observedClientCaps: ClientCapabilities | undefined;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { experimental: SERVER_EXPERIMENTAL } });
        s.server.oninitialized = () => {
            observedClientCaps = s.server.getClientCapabilities();
        };
        return s;
    };

    const client = new Client(
        { name: 'c', version: '0' },
        { capabilities: { roots: { listChanged: true }, experimental: CLIENT_EXPERIMENTAL } }
    );

    await using _ = await wire(transport, makeServer, client);

    // Server → client direction.
    const serverCaps = client.getServerCapabilities();
    expect(serverCaps?.experimental).toEqual(SERVER_EXPERIMENTAL);
    expect(serverCaps?.experimental?.['x-vendor/streaming']).toEqual({ version: 2, modes: ['delta', 'full'] });
    expect(serverCaps?.experimental?.['x-vendor/undeclared']).toBeUndefined();

    // Client → server direction (symmetric).
    expect(observedClientCaps?.experimental).toEqual(CLIENT_EXPERIMENTAL);
    expect(observedClientCaps?.experimental?.['x-vendor/undeclared']).toBeUndefined();
});

verifies('lifecycle:initialize:server-info', async ({ transport }: TestArgs) => {
    const extendedServerInfo: Implementation = {
        name: 'everything-extended',
        version: '1.2.3',
        title: 'Everything Server (Extended)',
        websiteUrl: 'https://example.com/everything',
        description: 'Reference everything-server with all optional Implementation fields populated.',
        icons: [
            { src: 'https://example.com/icon-48.png', mimeType: 'image/png', sizes: ['48x48'] },
            { src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] }
        ]
    };

    const makeServer = () => new McpServer(extendedServerInfo);
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);

    expect(client.getServerVersion()).toEqual(extendedServerInfo);
});

verifies('lifecycle:initialize:client-info', async ({ transport }: TestArgs) => {
    let observed: { before: Implementation | undefined; after: Implementation | undefined } | undefined;
    const makeServer = () => {
        const s = minimalServer();
        const before = s.server.getClientVersion();
        s.server.oninitialized = () => {
            observed = { before, after: s.server.getClientVersion() };
        };
        return s;
    };
    const client = minimalClient();

    await using _ = await wire(transport, makeServer, client);

    expect(observed?.before).toBeUndefined();
    expect(observed?.after).toEqual({ name: 'minimal-client', version: '0.0.0' });
});

verifies('typescript:server:get-client-capabilities', async ({ transport }: TestArgs) => {
    const DECLARED = {
        roots: { listChanged: true },
        sampling: {},
        experimental: { 'e2e-cap-marker': {} }
    };

    let observed:
        | { before: ClientCapabilities | undefined; after: ClientCapabilities | undefined; second: ClientCapabilities | undefined }
        | undefined;
    const makeServer = () => {
        const s = minimalServer();
        const before = s.server.getClientCapabilities();
        s.server.oninitialized = () => {
            const after = s.server.getClientCapabilities();
            observed = { before, after, second: s.server.getClientCapabilities() };
        };
        return s;
    };
    const client = new Client({ name: 'caps-probe-client', version: '0.0.0' }, { capabilities: DECLARED });

    await using _ = await wire(transport, makeServer, client);

    expect(observed?.before).toBeUndefined();
    expect(observed?.after).toEqual(DECLARED);
    expect(observed?.after?.elicitation).toBeUndefined();
    // Stable reference across calls.
    expect(observed?.second).toBe(observed?.after);
});
