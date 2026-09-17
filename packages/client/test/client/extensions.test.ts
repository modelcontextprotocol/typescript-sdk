/**
 * `ClientOptions.extensions`: an extension is advertised under the client's
 * `capabilities.extensions[id]` — in `initialize` on a legacy connection, in
 * every request's `_meta` client-capabilities envelope on a 2026-07-28
 * connection — and installed at construction, where it can register
 * handlers for server-to-client requests.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
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
        capability: { exampleData: true },
        install(client) {
            log.push('installed');
            client.setRequestHandler('gate/ping', { params: z.looseObject({}) }, () => ({ pong: true }));
            client.acceptResultType('tools/call', 'task');
        }
    };
}

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
                result: { resultType: 'task', taskId: 't-1', status: 'working', createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null }
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
    it('installs the extension at construction', () => {
        const log: string[] = [];
        new Client({ name: 'c', version: '1' }, { extensions: [gateExtension(log)] });
        expect(log).toEqual(['installed']);
    });

    it('defaults the advertised settings to {}', async () => {
        const { clientTx, written } = await scriptedServer('legacy');
        const client = new Client({ name: 'c', version: '1' }, { extensions: [{ id: 'com.example/plain', install: () => {} }] });
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
        // callTool validates against CallToolResultSchema, which a task handle does not satisfy.
        await expect(client.callTool({ name: 'slow', arguments: {} })).rejects.toThrow(/Invalid result for tools\/call/);
        await client.close();
    });

    it('serves the handler the extension installed for a server-to-client request', async () => {
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
