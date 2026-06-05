/**
 * Error-surface tests: which error class reaches the caller for each failure mode.
 *
 * The SDK splits failures into local {@link SdkError}s that never cross the wire
 * (timeouts, capability gating), wire-level {@link ProtocolError}s carrying the
 * JSON-RPC error code from an error response, and {@link SdkHttpError}s for HTTP
 * transport failures exposing the status code. Each test builds its own server
 * (factory) and client, triggers exactly one failure mode and asserts the class,
 * code and carried details of the rejection.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import {
    isJSONRPCErrorResponse,
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    SdkHttpError,
    Server
} from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession, tapWire, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const newClient = () => new Client({ name: 'c', version: '0' });

/** Awaits a promise that must reject and returns the rejection value for exact assertions. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => {
            throw new Error('expected the promise to reject');
        },
        (error: unknown) => error
    );
}

verifies('errors:timeout:sdkerror-request-timeout', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'generate_report',
            { inputSchema: z.object({ source: z.string() }) },
            async () =>
                new Promise(() => {
                    /* never resolves: the per-request timeout must fire before any response exists */
                })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const rejection = await rejectionOf(
        client.callTool({ name: 'generate_report', arguments: { source: 'sales-q3.csv' } }, { timeout: 100 })
    );

    expect(rejection).toBeInstanceOf(SdkError);
    if (!(rejection instanceof SdkError)) throw new Error('rejection is not an SdkError');
    expect(rejection.code).toBe(SdkErrorCode.RequestTimeout);
    expect(rejection.message).toMatch(/timed out/i);
    // The configured timeout value rides on the error, not just a generic message.
    expect(rejection.data).toEqual({ timeout: 100 });
    // A timeout is a local SDK error, not a JSON-RPC error response from the server.
    expect(rejection).not.toBeInstanceOf(ProtocolError);
});

verifies('errors:capability:sdkerror-capability-not-supported', async ({ transport }: TestArgs) => {
    let server: Server | undefined;
    const makeServer = () => {
        // Server-side gating of outbound requests on the client's declared capabilities is opt-in.
        server = new Server({ name: 's', version: '0' }, { capabilities: {}, enforceStrictCapabilities: true });
        return server;
    };
    // Client declares no sampling capability and registers no sampling handler.
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    if (!server) throw new Error('server not created');
    const serverTx = server.transport;
    if (!serverTx) throw new Error('server transport not connected');
    const serverOutbound: JSONRPCMessage[] = [];
    const origSend = serverTx.send.bind(serverTx);
    serverTx.send = async (m, opts) => {
        serverOutbound.push(m);
        return origSend(m, opts);
    };

    const rejection = await rejectionOf(
        server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the latest build log.' } }],
            maxTokens: 100
        })
    );

    expect(rejection).toBeInstanceOf(SdkError);
    // Rejected locally: not a JSON-RPC error that crossed the wire.
    expect(rejection).not.toBeInstanceOf(ProtocolError);
    if (!(rejection instanceof SdkError)) throw new Error('rejection is not an SdkError');
    expect(rejection.code).toBe(SdkErrorCode.CapabilityNotSupported);
    expect(rejection.message).toMatch(/does not support sampling/i);

    // No sampling/createMessage request was ever handed to the transport.
    expect(serverOutbound.filter(m => 'method' in m && m.method === 'sampling/createMessage')).toEqual([]);
    // The session stays healthy after the local rejection.
    await expect(client.ping()).resolves.toBeDefined();
});

verifies('errors:wire:protocolerror-invalid-params', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'get_weather',
            { inputSchema: z.object({ latitude: z.number(), longitude: z.number() }) },
            ({ latitude, longitude }) => ({ content: [{ type: 'text', text: `Sunny at ${latitude},${longitude}` }] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const tap = tapWire(client);

    // Calling a tool the server never registered produces a -32602 error response server-side.
    const rejection = await rejectionOf(client.callTool({ name: 'get_forecast', arguments: { latitude: 48.1, longitude: 11.6 } }));

    expect(rejection).toBeInstanceOf(ProtocolError);
    // Wire-level JSON-RPC errors and local SDK errors are distinct hierarchies.
    expect(rejection).not.toBeInstanceOf(SdkError);
    if (!(rejection instanceof ProtocolError)) throw new Error('rejection is not a ProtocolError');
    expect(rejection.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(rejection.code).toBe(-32_602);
    expect(rejection.message).toMatch(/tool get_forecast not found/i);

    // The error genuinely arrived as a JSON-RPC error response carrying the same code and message.
    const errorResponses = tap.received.filter(m => isJSONRPCErrorResponse(m));
    expect(errorResponses).toHaveLength(1);
    const wireError = errorResponses[0];
    if (!wireError) throw new Error('no JSON-RPC error response captured');
    expect(wireError.error.code).toBe(-32_602);
    expect(wireError.error.message).toBe(rejection.message);
});

verifies('errors:http:sdkhttperror-status', async (_: TestArgs) => {
    // HTTP-hosting specific: builds its own StreamableHTTPClientTransport, so the matrix transport arg is unused.

    // An endpoint that is down entirely: the initialize POST gets a plain 500.
    const downClient = newClient();
    const downTransport = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
        fetch: async () => new Response('upstream exploded', { status: 500, statusText: 'Internal Server Error' })
    });
    try {
        const rejection = await rejectionOf(downClient.connect(downTransport));

        expect(rejection).toBeInstanceOf(SdkHttpError);
        if (!(rejection instanceof SdkHttpError)) throw new Error('rejection is not an SdkHttpError');
        expect(rejection.status).toBe(500);
        expect(rejection.statusText).toBe('Internal Server Error');
    } finally {
        await downClient.close();
    }

    // A healthy session whose endpoint then starts answering POSTs with 503.
    const handle = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({ content: [{ type: 'text', text }] }));
        return s;
    });
    let postFailureStatus: number | undefined;
    const flakyFetch = async (url: URL | string, init?: RequestInit) => {
        if (postFailureStatus !== undefined && init?.method === 'POST') {
            return new Response('Service Unavailable', { status: postFailureStatus, statusText: 'Service Unavailable' });
        }
        return handle.handleRequest(new Request(url, init));
    };
    const client = newClient();
    const clientTransport = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: flakyFetch });
    try {
        await client.connect(clientTransport);
        // The session works before the outage.
        const ok = await client.callTool({ name: 'echo', arguments: { text: 'before outage' } });
        expect(ok.content).toEqual([{ type: 'text', text: 'before outage' }]);

        postFailureStatus = 503;
        const rejection = await rejectionOf(client.callTool({ name: 'echo', arguments: { text: 'during outage' } }));

        expect(rejection).toBeInstanceOf(SdkHttpError);
        if (!(rejection instanceof SdkHttpError)) throw new Error('rejection is not an SdkHttpError');
        expect(rejection.status).toBe(503);
        expect(rejection.statusText).toBe('Service Unavailable');
    } finally {
        await client.close();
        await handle.close();
    }
});
