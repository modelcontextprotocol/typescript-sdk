/**
 * `ClientOptions.extensions`: an extension is advertised under the client's
 * `capabilities.extensions[id]` — in `initialize` on a legacy connection, in
 * every request's `_meta` client-capabilities envelope on a 2026-07-28
 * connection — and set up at construction through a `ClientExtensionContext`,
 * which registers handlers for server-to-client requests, middleware,
 * capability settings, dependencies and accepted result kinds.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    SdkErrorCode
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { Client } from '../../src/client/client';
import type { ClientExtension } from '../../src/client/extension';

const MODERN = '2026-07-28';
const EXT_ID = 'com.example/gate';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

function gateExtension(log: string[]): ClientExtension {
    return {
        id: EXT_ID,
        setup(ctx) {
            log.push('set up');
            ctx.capability({ exampleData: true });
            ctx.setRequestHandler('gate/ping', { params: z.looseObject({}) }, () => ({ pong: true }));
            ctx.acceptResultType('tools/call', 'task');
        }
    };
}

const needs = (id: string, extensionId: `${string}/${string}`): ClientExtension => ({ id, setup: ctx => ctx.require(extensionId) });

/** A scripted server side: answers the handshake for the requested era and records everything the client writes. */
async function scriptedServer(era: 'modern' | 'legacy') {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const request = message as { id?: number | string; method?: string };
        if (request.id === undefined) return;
        if (request.method === 'server/discover') {
            void serverTx.send(
                era === 'modern'
                    ? {
                          jsonrpc: '2.0',
                          id: request.id,
                          result: {
                              resultType: 'complete',
                              supportedVersions: [MODERN],
                              capabilities: { tools: {} },
                              _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted', version: '1.0.0' } }
                          }
                      }
                    : { jsonrpc: '2.0', id: request.id, error: { code: -32_601, message: 'Method not found' } }
            );
        } else if (request.method === 'initialize') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'scripted', version: '1.0.0' }
                }
            });
        } else if (request.method === 'tools/call') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                // McpServer adds `content: []` to a task handle, so it also parses as a CallToolResult.
                result: {
                    resultType: 'task',
                    content: [],
                    taskId: 't-1',
                    status: 'working',
                    createdAt: 'now',
                    lastUpdatedAt: 'now',
                    ttlMs: null
                }
            });
        } else if (request.method === 'tools/list') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: era === 'modern' ? { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'public' } : { tools: [] }
            });
        }
    };
    await serverTx.start();
    return { clientTx, serverTx, written };
}

const paramsOf = (message: JSONRPCMessage): Record<string, unknown> => (message as { params?: Record<string, unknown> }).params ?? {};

describe('ClientOptions.extensions', () => {
    it('sets the extension up at construction, handing it the client', () => {
        const log: string[] = [];
        const seen: unknown[] = [];
        const client = new Client(
            { name: 'c', version: '1' },
            { extensions: [gateExtension(log), { id: 'com.example/probe', setup: ctx => void seen.push(ctx.client) }] }
        );
        expect(log).toEqual(['set up']);
        expect(seen).toEqual([client]);
    });

    it('refuses a custom method that is a core method, or one another extension already serves', () => {
        const claims = (id: string, name: string): ClientExtension => ({
            id,
            setup: ctx => ctx.setRequestHandler(name, { params: z.looseObject({}) }, () => ({}))
        });
        for (const name of ['tools/call', 'elicitation/create', 'sampling/createMessage', 'roots/list']) {
            expect(() => new Client({ name: 'c', version: '1' }, { extensions: [claims('com.example/a', name)] })).toThrow(
                `Extension "com.example/a" cannot register "${name}": it is a core method; wrap it with use() instead`
            );
        }
        expect(
            () =>
                new Client(
                    { name: 'c', version: '1' },
                    { extensions: [claims('com.example/a', 'x/ping'), claims('com.example/b', 'x/ping')] }
                )
        ).toThrow('Extension "com.example/b" cannot register "x/ping": another handler already serves it');
    });

    it('fails construction when a required extension is missing, and accepts it wherever it is listed', () => {
        expect(() => new Client({ name: 'c', version: '1' }, { extensions: [needs('com.example/b', 'com.example/a')] })).toThrow(
            'Extension "com.example/b" requires the "com.example/a" extension, which this client does not install'
        );
        const plain: ClientExtension = { id: 'com.example/a', setup: () => {} };
        expect(
            () => new Client({ name: 'c', version: '1' }, { extensions: [needs('com.example/b', 'com.example/a'), plain] })
        ).not.toThrow();
    });

    it('refuses a duplicate id before setting anything up', () => {
        const log: string[] = [];
        const make = () => new Client({ name: 'c', version: '1' }, { extensions: [gateExtension(log), gateExtension(log)] });
        expect(make).toThrow(`Extension "${EXT_ID}" is listed more than once`);
        expect(log).toEqual([]);
    });

    it('advertises {} when setup sets no capability', async () => {
        const { clientTx, written } = await scriptedServer('legacy');
        const client = new Client({ name: 'c', version: '1' }, { extensions: [{ id: 'com.example/plain', setup: () => {} }] });
        await client.connect(clientTx);
        const initialize = written.find(message => (message as { method?: string }).method === 'initialize');
        expect(paramsOf(initialize as JSONRPCMessage)['capabilities']).toMatchObject({ extensions: { 'com.example/plain': {} } });
        await client.close();
    });

    it('sends the extension in initialize on a legacy connection', async () => {
        const { clientTx, written } = await scriptedServer('legacy');
        const client = new Client({ name: 'c', version: '1' }, { extensions: [gateExtension([])] });
        await client.connect(clientTx);
        const initialize = written.find(message => (message as { method?: string }).method === 'initialize');
        expect(paramsOf(initialize as JSONRPCMessage)['capabilities']).toMatchObject({ extensions: { [EXT_ID]: { exampleData: true } } });
        await client.close();
    });

    it('stamps the extension into every request envelope on a 2026-07-28 connection', async () => {
        const { clientTx, written } = await scriptedServer('modern');
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' }, extensions: [gateExtension([])] });
        await client.connect(clientTx);
        await client.listTools();
        await flush();
        const toolsList = written.find(message => (message as { method?: string }).method === 'tools/list');
        const meta = paramsOf(toolsList as JSONRPCMessage)['_meta'] as Record<string, unknown>;
        expect(meta[CLIENT_CAPABILITIES_META_KEY]).toMatchObject({ extensions: { [EXT_ID]: { exampleData: true } } });
        await client.close();
    });

    it('receives an extension result kind the extension accepted, discriminator included', async () => {
        const { clientTx } = await scriptedServer('modern');
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' }, extensions: [gateExtension([])] });
        await client.connect(clientTx);
        const taskSchema = z.looseObject({ resultType: z.literal('task'), taskId: z.string(), status: z.string() });
        const result = await client.request({ method: 'tools/call', params: { name: 'slow', arguments: {} } }, taskSchema);
        expect(result).toMatchObject({ resultType: 'task', taskId: 't-1', status: 'working' });
        // Typed calls keep the closed vocabulary: callTool refuses the kind rather than return the handle as a tool result.
        await expect(client.callTool({ name: 'slow', arguments: {} })).rejects.toMatchObject({ code: SdkErrorCode.UnsupportedResultType });
        await client.close();
    });

    it('serves the handler the extension registered for a server-to-client request', async () => {
        const { clientTx, serverTx, written } = await scriptedServer('legacy');
        const client = new Client({ name: 'c', version: '1' }, { extensions: [gateExtension([])] });
        await client.connect(clientTx);
        await serverTx.send({ jsonrpc: '2.0', id: 'srv-1', method: 'gate/ping', params: {} });
        await flush();
        const response = written.find(message => 'id' in message && message.id === 'srv-1');
        expect((response as { result?: unknown }).result).toEqual({ pong: true });
        await client.close();
    });
});
