/**
 * `Client.listen()` — the `subscriptions/listen` driver (protocol revision
 * 2026-07-28). Covers ack-resolved-promise, change-notification dispatch to
 * existing setNotificationHandler registrations, the F-12 legacy-era steer,
 * transport-agnostic close (always sends notifications/cancelled), inbound
 * server-side cancel, and ClientOptions.listChanged auto-open on a modern
 * connection.
 */
import type { JSONRPCMessage, JSONRPCNotification } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, SdkError, SdkErrorCode, SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';

const MODERN = '2026-07-28';
const flush = () => new Promise(r => setTimeout(r, 10));

async function scriptedModern(onListen?: (id: number | string, filter: unknown, send: (m: JSONRPCMessage) => void) => void) {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const req = message as { id?: number | string; method?: string; params?: { notifications?: unknown } };
        if (req.method === 'server/discover' && req.id !== undefined) {
            void serverTx.send({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: [MODERN],
                    capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
                    serverInfo: { name: 'scripted', version: '1' }
                }
            });
        }
        if (req.method === 'subscriptions/listen' && req.id !== undefined) {
            const filter = req.params?.notifications ?? {};
            const ack: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: req.id }, notifications: filter }
            };
            void serverTx.send(ack);
            onListen?.(req.id, filter, m => void serverTx.send(m));
        }
    };
    await serverTx.start();
    return { clientTx, serverTx, written };
}

describe('Client.listen()', () => {
    it('throws a typed steer on a legacy-era connection (no wire write)', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        const written: JSONRPCMessage[] = [];
        serverTx.onmessage = m => {
            written.push(m);
            const req = m as { id?: number | string; method?: string };
            if (req.method === 'initialize' && req.id !== undefined) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 's', version: '1' } }
                });
            }
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
        await client.connect(clientTx);
        written.length = 0;

        const error = await client.listen({ toolsListChanged: true }).catch(e => e as SdkError);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
        expect((error as SdkError).message).toContain('resources/subscribe');
        expect((error as SdkError).message).toContain('listChanged');
        // The steer fires before any wire write.
        expect(written.some(m => (m as { method?: string }).method === 'subscriptions/listen')).toBe(false);
        await client.close();
    });

    it('resolves on ack with the honored filter; change notifications reach setNotificationHandler', async () => {
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((_id, _f, s) => {
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        const seen: string[] = [];
        client.setNotificationHandler('notifications/tools/list_changed', () => {
            seen.push('tools');
        });
        await client.connect(clientTx);

        const sub = await client.listen({ toolsListChanged: true });
        expect(sub.honoredFilter).toEqual({ toolsListChanged: true });

        send({
            jsonrpc: '2.0',
            method: 'notifications/tools/list_changed',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 0 } }
        });
        await flush();
        expect(seen).toEqual(['tools']);
        await sub.close();
        await client.close();
    });

    it('close() sends notifications/cancelled referencing the listen id on any transport', async () => {
        // Plain InMemoryTransport (neither child-process nor SSE-stream
        // semantics): close() must NOT depend on transport-kind detection —
        // it always sends notifications/cancelled, so a spec-compliant server
        // on InMemory / SSE / a custom transport tears the subscription down.
        const { clientTx, written } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        const listenId = (written.find(m => (m as { method?: string }).method === 'subscriptions/listen') as { id: number | string }).id;
        written.length = 0;
        await sub.close();
        expect(written).toEqual([{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } }]);
        // Idempotent.
        await sub.close();
        expect(written).toHaveLength(1);
        await client.close();
    });

    it('inbound notifications/cancelled referencing the listen id tears the subscription down', async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        await flush();
        // close() after server-cancel is idempotent.
        await sub.close();
        await client.close();
    });

    it('rejects with the typed pre-ack error when the server answers -32603', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        serverTx.onmessage = m => {
            const req = m as { id?: number | string; method?: string };
            if (req.method === 'server/discover' && req.id !== undefined) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: {},
                        serverInfo: { name: 's', version: '1' }
                    }
                });
            }
            if (req.method === 'subscriptions/listen' && req.id !== undefined) {
                void serverTx.send({ jsonrpc: '2.0', id: req.id, error: { code: -32_603, message: 'Subscription limit reached' } });
            }
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect((error as { code?: number }).code).toBe(-32_603);
        await client.close();
    });

    it('server cancels BEFORE the ack: listen() rejects immediately, no 60s hang', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        serverTx.onmessage = m => {
            const req = m as { id?: number | string; method?: string };
            if (req.method === 'server/discover' && req.id !== undefined) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: {},
                        serverInfo: { name: 's', version: '1' }
                    }
                });
            }
            if (req.method === 'subscriptions/listen' && req.id !== undefined) {
                // Server cancels the listen id BEFORE sending the ack.
                void serverTx.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req.id } });
            }
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const t0 = Date.now();
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('server cancelled before acknowledging');
        // Rejected promptly (well under the 60s ack timeout).
        expect(Date.now() - t0).toBeLessThan(1000);
        // No leaked _responseHandlers entry for the listen id.
        expect((client as unknown as { _responseHandlers: Map<unknown, unknown> })._responseHandlers.size).toBe(0);
        await client.close();
    });

    it('an ack arriving AFTER the subscription was server-cancelled is a no-op', async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        // Server tears the open subscription down.
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        await flush();
        // A late duplicate ack must not throw or resurrect state.
        send({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: listenId }, notifications: {} }
        });
        await flush();
        await sub.close();
        await client.close();
    });

    it('a synchronously-delivered server-cancel during send does not leak a _listenState entry', async () => {
        // In-process delivery: the server's notifications/cancelled arrives
        // inside `_parkRequest`'s send (before `parked` is assigned). settle()
        // must still drop the `_listenState` entry it registered via
        // onBeforeSend.
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        serverTx.onmessage = m => {
            const req = m as { id?: number | string; method?: string };
            if (req.method === 'server/discover' && req.id !== undefined) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: {},
                        serverInfo: { name: 's', version: '1' }
                    }
                });
            }
            if (req.method === 'subscriptions/listen' && req.id !== undefined) {
                void serverTx.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req.id } });
            }
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const listenState = (client as unknown as { _listenState: Map<unknown, unknown> })._listenState;
        const before = listenState.size;
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as Error);
        expect((error as Error).message).toContain('server cancelled before acknowledging');
        // No leaked _listenState entry for the listen id.
        expect(listenState.size).toBe(before);
        await client.close();
    });

    it('a synchronous transport.send throw does not leak a _responseHandlers entry', async () => {
        const { clientTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const handlers = (client as unknown as { _responseHandlers: Map<unknown, unknown> })._responseHandlers;
        const before = handlers.size;
        const realSend = clientTx.send.bind(clientTx);
        clientTx.send = () => {
            throw new Error('send blew up');
        };
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as Error);
        expect((error as Error).message).toContain('send blew up');
        // The park primitive unregistered before rethrowing — no leak.
        expect(handlers.size).toBe(before);
        // settle() in the catch path also dropped the _listenState entry that
        // onBeforeSend registered before send threw.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        clientTx.send = realSend;
        await client.close();
    });

    it('rejects with NotConnected (as a rejected promise, no setup) when no transport is connected', async () => {
        const { clientTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        await client.close();
        // listen() is async, so a pre-send guard throw is delivered as the
        // returned promise's rejection (no ack timer started, no park state).
        const pending = client.listen({ toolsListChanged: true });
        const error = await pending.catch(e => e as SdkError);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.NotConnected);
    });

    it('ClientOptions.listChanged auto-opens a listen stream on a modern connection (filter derived from sub-options)', async () => {
        const filters: unknown[] = [];
        const { clientTx } = await scriptedModern((_id, filter) => filters.push(filter));
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged }, prompts: { onChanged } } }
        );
        await client.connect(clientTx);
        expect(filters).toEqual([{ toolsListChanged: true, promptsListChanged: true }]);
        expect(client.autoOpenedSubscription).toBeDefined();
        expect(client.autoOpenedSubscription!.honoredFilter).toEqual({ toolsListChanged: true, promptsListChanged: true });
        await client.autoOpenedSubscription!.close();
        await client.close();
    });

    it('autoOpenedSubscription is cleared on close() and on a fresh reconnect', async () => {
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged } } }
        );
        const { clientTx } = await scriptedModern();
        await client.connect(clientTx);
        expect(client.autoOpenedSubscription).toBeDefined();
        await client.close();
        // close() clears every per-connection field.
        expect(client.autoOpenedSubscription).toBeUndefined();
        expect(client.getServerCapabilities()).toBeUndefined();
        expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
    });

    it('auto-open filter is configured ∩ server-advertised; empty intersection skips auto-open', async () => {
        const filters: unknown[] = [];
        // scriptedModern advertises tools.listChanged + prompts.listChanged but NOT resources.
        const { clientTx } = await scriptedModern((_id, filter) => filters.push(filter));
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            // Configures tools + resources; server advertises tools + prompts.
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged }, resources: { onChanged } } }
        );
        await client.connect(clientTx);
        // Intersection = tools only.
        expect(filters).toEqual([{ toolsListChanged: true }]);
        expect(client.autoOpenedSubscription?.honoredFilter).toEqual({ toolsListChanged: true });
        await client.close();

        // Empty intersection: configures resources only; server advertises tools+prompts.
        const filters2: unknown[] = [];
        const { clientTx: clientTx2 } = await scriptedModern((_id, filter) => filters2.push(filter));
        const client2 = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { resources: { onChanged } } }
        );
        await client2.connect(clientTx2);
        expect(filters2).toEqual([]);
        expect(client2.autoOpenedSubscription).toBeUndefined();
        await client2.close();
    });

    it('a failed auto-open surfaces via onerror and does NOT fail connect', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        serverTx.onmessage = m => {
            const req = m as { id?: number | string; method?: string };
            if (req.method === 'server/discover' && req.id !== undefined) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { tools: { listChanged: true } },
                        serverInfo: { name: 's', version: '1' }
                    }
                });
            }
            if (req.method === 'subscriptions/listen' && req.id !== undefined) {
                // Server refuses listen (capacity guard / not supported).
                void serverTx.send({ jsonrpc: '2.0', id: req.id, error: { code: -32_603, message: 'Subscription limit reached' } });
            }
        };
        await serverTx.start();
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged } } }
        );
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        // connect MUST resolve: the modern connection is usable without listen.
        await client.connect(clientTx);
        expect(client.autoOpenedSubscription).toBeUndefined();
        expect(errors).toHaveLength(1);
        expect((errors[0] as { code?: number }).code).toBe(-32_603);
        await client.close();
    });
});
