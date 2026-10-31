import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, Server } from '@modelcontextprotocol/server';
import { SpanKind } from '@opentelemetry/api';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { registerTestSdk } from './sdk';

const sdk = registerTestSdk();
beforeEach(() => sdk.reset());
afterAll(() => sdk.unregister());

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Connects a raw transport to `server`, so a test can send exactly the messages a hostile peer would. */
async function rawPeer(server: McpServer | Server) {
    const [peer, serverSide] = InMemoryTransport.createLinkedPair();
    const received: JSONRPCMessage[] = [];
    peer.onmessage = message => received.push(message);
    await server.connect(serverSide);
    await peer.start();
    return { peer, received };
}

const initialize = (protocolVersion: string) =>
    ({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'peer', version: '1' } }
    }) as const;

/** Metric attribute sets recorded for a histogram. */
const metricAttributes = async (name: string) => {
    const { points } = await sdk.histogram(name);
    return points.map(point => point.attributes);
};

describe('client-chosen strings stay out of span names and metrics', () => {
    it('records methods served only by a fallback handler as _OTHER, but keeps spec method names', async () => {
        const server = new Server({ name: 'gateway', version: '1.0.0' }, { capabilities: { completions: {} } });
        server.fallbackRequestHandler = async () => ({});
        server.fallbackNotificationHandler = async () => {};
        const client = new Client({ name: 'agent', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

        await client.request({ method: 'x/random-1234', params: {} }, z.object({}));
        await client.notification({ method: 'x/random-5678', params: {} });
        await client.request(
            { method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: 'b' } } },
            z.object({})
        );
        await tick();

        const serverSpans = sdk.spans().filter(span => span.kind === SpanKind.SERVER);
        expect(serverSpans.filter(span => span.name === '_OTHER')).toHaveLength(2);
        expect(serverSpans.map(span => span.name)).toContain('completion/complete');
        expect(serverSpans.map(span => span.name).join(',')).not.toContain('random');
        expect(JSON.stringify(await metricAttributes('mcp.server.operation.duration'))).not.toContain('random');
        await client.close();
    });

    it('drops an unknown tool name when the call is cancelled before the server answers', async () => {
        const server = new McpServer({ name: 'weather', version: '1.0.0' });
        server.registerTool('get-weather', { inputSchema: z.object({}) }, () => ({ content: [] }));
        const { peer } = await rawPeer(server);
        await peer.send(initialize('2025-11-25'));
        await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        // The cancellation lands before the -32602 the unknown tool would have produced.
        await peer.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'random-tool-9876', arguments: {} } });
        await peer.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'never mind' } });
        await tick();

        const span = sdk.span('tools/call', SpanKind.SERVER);
        expect(span.attributes['error.type']).toBe('cancelled');
        expect(JSON.stringify(await metricAttributes('mcp.server.operation.duration'))).not.toContain('random-tool');
        await server.close();
    });

    it('drops a tool name sent to a server that has no tool handler at all', async () => {
        const server = new McpServer({ name: 'docs', version: '1.0.0' });
        server.registerResource('readme', 'file:///readme.md', {}, uri => ({ contents: [{ uri: uri.href, text: '# hi' }] }));
        const { peer, received } = await rawPeer(server);
        await peer.send(initialize('2025-11-25'));
        await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        await peer.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'random-tool-5555', arguments: {} } });
        await tick();

        expect(received).toContainEqual(expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32_601 }) }));
        const span = sdk.span('tools/call', SpanKind.SERVER);
        expect(span.attributes['rpc.response.status_code']).toBe('-32601');
        expect(JSON.stringify(await metricAttributes('mcp.server.operation.duration'))).not.toContain('random-tool');
        await server.close();
    });

    it('records the protocol version an initialize requests only when the server supports it', async () => {
        const server = new McpServer({ name: 'weather', version: '1.0.0' });
        const { peer } = await rawPeer(server);

        await peer.send(initialize('bogus-version-4242'));
        await tick();

        const span = sdk.span('initialize', SpanKind.SERVER);
        expect(span.attributes['mcp.protocol.version']).toBeUndefined();
        expect(JSON.stringify(await metricAttributes('mcp.server.operation.duration'))).not.toContain('bogus-version');
        await server.close();

        sdk.reset();
        const supported = new McpServer({ name: 'weather', version: '1.0.0' });
        const second = await rawPeer(supported);
        await second.peer.send(initialize('2025-11-25'));
        await tick();
        expect(sdk.span('initialize', SpanKind.SERVER).attributes['mcp.protocol.version']).toBe('2025-11-25');
        await supported.close();
    });

    it("buckets a server's application-defined error codes on the client's metrics, keeping the exact code on the span", async () => {
        const [clientTransport, peer] = InMemoryTransport.createLinkedPair();
        peer.onmessage = message => {
            if (!('id' in message) || !('method' in message)) return;
            if (message.method === 'initialize') {
                void peer.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'hostile', version: '1' } }
                });
            } else {
                void peer.send({ jsonrpc: '2.0', id: message.id, error: { code: 918_273, message: 'made up' } });
            }
        };
        await peer.start();
        const client = new Client({ name: 'agent', version: '1.0.0' });
        await client.connect(clientTransport);

        await expect(client.request({ method: 'x/anything', params: {} }, z.object({}))).rejects.toThrow('made up');

        expect(sdk.span('x/anything', SpanKind.CLIENT).attributes).toMatchObject({
            'error.type': '918273',
            'rpc.response.status_code': '918273'
        });
        const clientMetrics = await metricAttributes('mcp.client.operation.duration');
        expect(clientMetrics).toContainEqual(expect.objectContaining({ 'error.type': '_OTHER', 'rpc.response.status_code': '_OTHER' }));
        expect(JSON.stringify(clientMetrics)).not.toContain('918273');
        await client.close();
    });
});
