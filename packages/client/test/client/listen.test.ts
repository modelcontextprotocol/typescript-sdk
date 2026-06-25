/**
 * `Client.listen()` — the `subscriptions/listen` driver (protocol revision
 * 2026-07-28). Covers ack-resolved-promise, change-notification dispatch to
 * existing setNotificationHandler registrations, the F-12 legacy-era steer,
 * transport-agnostic close (always sends notifications/cancelled), inbound
 * server-side cancel, and ClientOptions.listChanged auto-open on a modern
 * connection.
 */
import type { JSONRPCMessage, JSONRPCNotification } from '@modelcontextprotocol/core-internal';
import {
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client';

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

/**
 * Like `scriptedModern` but does NOT auto-ack `subscriptions/listen`: the
 * test drives ack / cancel / transport-close itself.
 */
async function scriptedModernNoAck() {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const req = message as { id?: number | string; method?: string };
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
        expect(written).toHaveLength(1);
        const cancel = written[0] as unknown as { method: string; params: { requestId: unknown; _meta?: Record<string, unknown> } };
        expect(cancel.method).toBe('notifications/cancelled');
        expect(cancel.params.requestId).toBe(listenId);
        // The listen-path cancel carries the same modern auto-envelope as
        // every other outbound (request()'s cancel, Protocol.notification()).
        expect(cancel.params._meta?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);
        // Idempotent.
        await sub.close();
        expect(written).toHaveLength(1);
        await client.close();
    });

    it("inbound notifications/cancelled post-ack: closed resolves 'remote'; subscription torn down; handlers stop firing", async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        const seen: string[] = [];
        client.setNotificationHandler('notifications/tools/list_changed', () => {
            seen.push('tools');
        });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        // The spec-defined remote termination signal is now observable on the
        // subscription handle; settle() is the funnel and resolves it once.
        await expect(sub.closed).resolves.toBe('remote');
        // Per-listen state is gone; the request signal was aborted (so an HTTP
        // SSE reader would have stopped).
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        // After a server-side close, the server stops delivering on this stream
        // — a notification carrying this subscription id is no longer routed
        // through any per-listen entry (the entry is gone). The handler is the
        // shared setNotificationHandler registration; assert no later
        // dispatch from THIS subscription's stream by asserting no entry exists
        // to demux it.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.has(listenId)).toBe(false);
        expect(seen).toEqual([]);
        // close() after server-cancel is idempotent and does NOT change the
        // already-resolved cause.
        await sub.close();
        await expect(sub.closed).resolves.toBe('remote');
        await client.close();
    });

    it("close() resolves closed with 'local' exactly once", async () => {
        const { clientTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        await sub.close();
        await expect(sub.closed).resolves.toBe('local');
        // A second close() and a later remote signal cannot change it.
        await sub.close();
        await expect(sub.closed).resolves.toBe('local');
        await client.close();
    });

    it('closed resolves exactly once even when multiple termination signals arrive', async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx, serverTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        const resolutions: string[] = [];
        void sub.closed.then(cause => resolutions.push(cause));
        // Three signals in quick succession: server-cancel, a duplicate
        // server-cancel, then transport close. settle()'s `closed` guard
        // means only the first transitions; `closed` resolves once.
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        await serverTx.close();
        await flush();
        expect(resolutions).toEqual(['remote']);
        // sub.close() after the fact is still idempotent and cannot flip it.
        await sub.close();
        await expect(sub.closed).resolves.toBe('remote');
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
        expect((error as Error).message).toContain('server cancelled the subscription');
        // Rejected promptly (well under the 60s ack timeout).
        expect(Date.now() - t0).toBeLessThan(1000);
        // No leaked per-listen state for the listen id.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
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
        // inside `transport.send()` (before the `await opening`). settle()
        // must still drop the `_listenState` entry registered before send.
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
        expect((error as Error).message).toContain('server cancelled the subscription');
        // No leaked _listenState entry for the listen id.
        expect(listenState.size).toBe(before);
        await client.close();
    });

    it('a synchronous transport.send throw does not leak a _listenState entry', async () => {
        const { clientTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const realSend = clientTx.send.bind(clientTx);
        clientTx.send = () => {
            throw new Error('send blew up');
        };
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as Error);
        expect((error as Error).message).toContain('send blew up');
        // settle() in the catch path dropped the _listenState entry that was
        // registered before send threw; listen() never registers in
        // Protocol's `_responseHandlers` so there is nothing to leak there.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        expect((client as unknown as { _responseHandlers: Map<unknown, unknown> })._responseHandlers.size).toBe(0);
        clientTx.send = realSend;
        await client.close();
    });

    it('options.signal already aborted: listen() rejects with SdkError(RequestTimeout) before any setup (parity with request())', async () => {
        const { clientTx, written } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        written.length = 0;
        const ac = new AbortController();
        ac.abort('user cancelled');
        const error = await client.listen({ toolsListChanged: true }, { signal: ac.signal }).catch(e => e as SdkError);
        // Same wrap as `Protocol.request()` / `_serveFromCache`: a non-SdkError
        // reason is wrapped as RequestTimeout; the reason text is preserved.
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
        expect((error as SdkError).message).toContain('user cancelled');
        // No subscriptions/listen reached the wire; no listen state registered.
        await flush();
        expect(written.find(m => (m as { method?: string }).method === 'subscriptions/listen')).toBeUndefined();
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        // An SdkError reason is preserved verbatim (not double-wrapped).
        const ac2 = new AbortController();
        const own = new SdkError(SdkErrorCode.NotConnected, 'upstream');
        ac2.abort(own);
        const error2 = await client.listen({ toolsListChanged: true }, { signal: ac2.signal }).catch(e => e as SdkError);
        expect(error2).toBe(own);
        await client.close();
    });

    it('options.signal aborted while opening: listen() rejects fast with the signal reason', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        const written: JSONRPCMessage[] = [];
        serverTx.onmessage = m => {
            written.push(m);
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
            // No ack for subscriptions/listen — stays in `opening`.
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const ac = new AbortController();
        const t0 = Date.now();
        const pending = client.listen({ toolsListChanged: true }, { signal: ac.signal });
        ac.abort(new Error('caller-abort'));
        const error = await pending.catch(e => e as Error);
        expect((error as Error).message).toBe('caller-abort');
        expect(Date.now() - t0).toBeLessThan(1000);
        // wireTeardown sent notifications/cancelled referencing the listen id.
        await flush();
        const listenId = (written.find(m => (m as { method?: string }).method === 'subscriptions/listen') as { id: number | string }).id;
        const cancelled = written.find(m => (m as { method?: string }).method === 'notifications/cancelled') as
            | { params: { requestId: unknown } }
            | undefined;
        expect(cancelled?.params.requestId).toBe(listenId);
        // No leaked state.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it('options.signal aborted while open: closes the subscription (notifications/cancelled sent)', async () => {
        const { clientTx, written } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const ac = new AbortController();
        const sub = await client.listen({ toolsListChanged: true }, { signal: ac.signal });
        const listenId = (written.find(m => (m as { method?: string }).method === 'subscriptions/listen') as { id: number | string }).id;
        written.length = 0;
        ac.abort();
        await flush();
        expect(written).toHaveLength(1);
        expect((written[0] as JSONRPCNotification).method).toBe('notifications/cancelled');
        expect((written[0] as unknown as { params: { requestId: unknown } }).params.requestId).toBe(listenId);
        // Caller-signal abort is consumer-initiated → 'local'.
        await expect(sub.closed).resolves.toBe('local');
        // close() after signal-abort is idempotent.
        await sub.close();
        expect(written).toHaveLength(1);
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

    it('ClientOptions.listChanged auto-opens a listen stream on a modern connection (filter = configured ∩ server-advertised)', async () => {
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

    it('a misconfigured listChanged handler surfaces via onerror and SKIPS auto-open (no wire write)', async () => {
        // Regression: when handler registration threw (the soft-fail catch),
        // the auto-open filter was still built from the same `effective`,
        // opening a listen stream for types whose handler never registered —
        // delivered notifications dropped on the floor while consuming a
        // server slot. Now a registration failure skips auto-open entirely.
        const { clientTx, written } = await scriptedModernNoAck();
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged, debounceMs: -1 } } }
        );
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        // connect MUST resolve: the modern connection is usable without listen.
        await client.connect(clientTx);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain('Invalid tools listChanged options');
        // Auto-open SKIPPED: no listen request hit the wire, no subscription.
        expect(client.autoOpenedSubscription).toBeUndefined();
        expect(written.some(m => (m as { method?: string }).method === 'subscriptions/listen')).toBe(false);
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it('connect-scoped signal does NOT bind to the auto-opened subscription lifetime', async () => {
        // Regression: forwarding connect()'s full RequestOptions into the
        // auto-open listen() call meant a connect-scoped signal — typically
        // `AbortSignal.timeout(30_000)` for the handshake — was bound to the
        // SUBSCRIPTION lifetime. When it fired after connect resolved, the
        // auto-opened stream was silently torn down.
        const { clientTx, written } = await scriptedModern();
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged } } }
        );
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        const connectScoped = new AbortController();
        await client.connect(clientTx, { signal: connectScoped.signal });
        expect(client.autoOpenedSubscription).toBeDefined();
        written.length = 0;

        // The connect-scoped signal fires AFTER connect resolved (as a
        // handshake `AbortSignal.timeout` would).
        connectScoped.abort();
        await flush();

        // The auto-opened subscription is still live: no wire teardown
        // (`notifications/cancelled`) was sent, and the per-listen state
        // entry is still registered.
        expect(written.some(m => (m as JSONRPCNotification).method === 'notifications/cancelled')).toBe(false);
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(1);
        expect(errors).toHaveLength(0);
        await client.close();
    });

    it('connect-scoped signal aborted DURING the auto-open ack wait: connect rejects fast (no 60s hang)', async () => {
        // Regression: forwarding only {timeout} into the auto-open listen()
        // meant connect()'s signal could not cancel the in-connect ack wait —
        // an aborted connect blocked here for the full ack timeout.
        const { clientTx } = await scriptedModernNoAck();
        const closeSpy = vi.spyOn(clientTx, 'close');
        const onChanged = () => {};
        const client = new Client(
            { name: 'c', version: '1' },
            { versionNegotiation: { mode: 'auto' }, listChanged: { tools: { onChanged } } }
        );
        const connectScoped = new AbortController();
        const t0 = Date.now();
        const pending = client.connect(clientTx, { signal: connectScoped.signal });
        // discover resolves; connect is now awaiting the auto-open ack.
        await flush();
        connectScoped.abort(new Error('connect-abort'));
        const error = await pending.catch(e => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(1000);
        // No leaked per-listen state on the aborted connect.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        // A connect() rejection MUST NOT leave a half-open connection: the
        // transport was closed before rethrowing (b142b80ea regression assertion).
        await flush();
        expect(closeSpy).toHaveBeenCalled();
        expect(client.transport).toBeUndefined();
        await client.close();
    });

    it('server answers listen with a JSON-RPC RESULT during opening: rejects ConnectionClosed (graceful pre-ack close, not 60s)', async () => {
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
                // Server is shutting down: emits the SubscriptionsListenResult
                // before ever sending the ack. The client treats receipt of
                // any result for the listen id as the graceful-close signal.
                void serverTx.send({ jsonrpc: '2.0', id: req.id, result: {} });
            }
        };
        await serverTx.start();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const t0 = Date.now();
        const error = await client.listen({ toolsListChanged: true }).catch(e => e as SdkError);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
        expect((error as SdkError).message).toContain('closed the subscription gracefully before acknowledging');
        expect(Date.now() - t0).toBeLessThan(1000);
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it("inbound SubscriptionsListenResult post-ack: closed resolves 'graceful'; subscription torn down", async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        // The spec's graceful-close signal: the server emits the empty
        // subscriptions/listen response, then closes the stream.
        send({
            jsonrpc: '2.0',
            id: listenId,
            result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META_KEY]: listenId } }
        } as JSONRPCMessage);
        await expect(sub.closed).resolves.toBe('graceful');
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it('transport closes BEFORE the ack: listen() rejects fast', async () => {
        const { clientTx, serverTx } = await scriptedModernNoAck();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const t0 = Date.now();
        const pending = client.listen({ toolsListChanged: true });
        await flush();
        // Server-side transport closes before ever acking → Client's
        // `_onclose` override settles every per-listen state machine.
        await serverTx.close();
        const error = await pending.catch(e => e as Error);
        expect(error).toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(1000);
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        expect((client as unknown as { _responseHandlers: Map<unknown, unknown> })._responseHandlers.size).toBe(0);
    });

    it("transport closes WHILE the subscription is open: closed resolves 'remote'; close() is a no-op", async () => {
        const { clientTx, serverTx, written } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(1);
        await serverTx.close();
        await expect(sub.closed).resolves.toBe('remote');
        // Transport-close settled the per-listen machine; nothing leaks.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        // sub.close() after transport-close is a no-op (state already 'closed'):
        // no notifications/cancelled lands on a future connection.
        written.length = 0;
        await sub.close();
        expect(written.some(m => (m as { method?: string }).method === 'notifications/cancelled')).toBe(false);
    });

    it('concurrent listens are independent (each ack resolves its own promise; closing one leaves the other open)', async () => {
        const ids: (number | string)[] = [];
        const { clientTx, written } = await scriptedModern(id => ids.push(id));
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const [a, b] = await Promise.all([client.listen({ toolsListChanged: true }), client.listen({ promptsListChanged: true })]);
        expect(a.honoredFilter).toEqual({ toolsListChanged: true });
        expect(b.honoredFilter).toEqual({ promptsListChanged: true });
        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
        const listenState = (client as unknown as { _listenState: Map<unknown, unknown> })._listenState;
        expect(listenState.size).toBe(2);
        written.length = 0;
        await a.close();
        // Only `a`'s id is cancelled; `b` stays open.
        expect(written).toHaveLength(1);
        expect((written[0] as JSONRPCNotification).method).toBe('notifications/cancelled');
        expect((written[0] as unknown as { params: { requestId: unknown } }).params.requestId).toBe(ids[0]);
        expect(listenState.size).toBe(1);
        await b.close();
        expect(listenState.size).toBe(0);
        await client.close();
    });

    it('after close(): nothing further dispatched into the per-listen machine; late ack passes through unconsumed', async () => {
        let listenId!: number | string;
        let send!: (m: JSONRPCMessage) => void;
        const { clientTx } = await scriptedModern((id, _f, s) => {
            listenId = id;
            send = s;
        });
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        await sub.close();
        // The per-listen entry is gone; a late server-side ack and a late
        // server-side cancel for this id are NOT consumed by the
        // `_onnotification` override (no entry matches) and reach the
        // fallback handler.
        const fallback: string[] = [];
        client.fallbackNotificationHandler = async n => {
            fallback.push(n.method);
        };
        send({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: listenId }, notifications: {} }
        });
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: listenId } } as JSONRPCNotification);
        await flush();
        expect(fallback).toContain('notifications/subscriptions/acknowledged');
        // The state machine stayed closed throughout (no leak, no resurrection).
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it('an unmatched ack passes through to fallbackNotificationHandler (not silently swallowed)', async () => {
        const { clientTx, serverTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        const fallback: string[] = [];
        client.fallbackNotificationHandler = async n => {
            fallback.push(n.method);
        };
        await client.connect(clientTx);
        // One listen is active; a stray ack referencing a FOREIGN id must
        // reach the fallback handler instead of being silently swallowed.
        const sub = await client.listen({ toolsListChanged: true });
        await serverTx.send({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 'foreign-id' }, notifications: {} }
        });
        await flush();
        expect(fallback).toEqual(['notifications/subscriptions/acknowledged']);
        await sub.close();
        await client.close();
    });

    it('a fresh connect without an intervening close settles in-flight listen() from the prior connection', async () => {
        // Edge: prior transport never fires onclose; consumer calls connect()
        // again. The in-flight listen() promise from the old connection must
        // reject with a clear "client reconnected/closed" error rather than
        // hang on the (now-discarded) ack timer.
        const { clientTx } = await scriptedModernNoAck();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const pending = client.listen({ toolsListChanged: true });
        await flush();
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(1);
        // Fresh connect on a new transport — _resetConnectionState runs.
        const { clientTx: clientTx2 } = await scriptedModern();
        await client.connect(clientTx2);
        const error = await pending.catch(e => e as Error);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.ConnectionClosed);
        expect((error as SdkError).message).toContain('reconnected or closed');
        // No leaked per-listen state from the old connection.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        await client.close();
    });

    it("the listen request id is a STRING on the wire ('listen:N'); cancel echoes it verbatim", async () => {
        const { clientTx, written } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        const wireListen = written.find(m => (m as { method?: string }).method === 'subscriptions/listen') as {
            id: unknown;
            params: { _meta?: Record<string, unknown> };
        };
        // String id from a Client-owned counter — JSON-RPC valid; spec
        // subscriptionId is the request id verbatim; zero collision with
        // Protocol's numeric counter.
        expect(typeof wireListen.id).toBe('string');
        expect(wireListen.id).toMatch(/^listen:\d+$/);
        // The auto-envelope is on the wire too.
        expect(wireListen.params._meta?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);
        written.length = 0;
        await sub.close();
        const cancel = written[0] as unknown as { method: string; params: { requestId: unknown } };
        expect(cancel.params.requestId).toBe(wireListen.id);
        await client.close();
    });

    it("transport-level per-request stream end (onRequestStreamEnd) → closed resolves 'remote'", async () => {
        // Mock a transport that captures the per-request `onRequestStreamEnd`
        // callback and fires it after the ack — simulating a Streamable HTTP
        // server closing the listen request's SSE stream.
        const { clientTx, serverTx } = await scriptedModern();
        let onStreamEnd: (() => void) | undefined;
        const realSend = clientTx.send.bind(clientTx);
        clientTx.send = (m, opts) => {
            if ((m as { method?: string }).method === 'subscriptions/listen') {
                onStreamEnd = (opts as { onRequestStreamEnd?: () => void } | undefined)?.onRequestStreamEnd;
            }
            return realSend(m, opts);
        };
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        const sub = await client.listen({ toolsListChanged: true });
        expect(onStreamEnd).toBeDefined();
        // Transport reports the per-request stream ended (server closed the
        // SSE response, network dropped it, reconnection exhausted).
        onStreamEnd!();
        await expect(sub.closed).resolves.toBe('remote');
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        // close() after stream-end is a no-op (state already 'closed').
        await sub.close();
        await serverTx.close();
    });

    it('close() resets per-connection state even when transport.close() rejects', async () => {
        const { clientTx } = await scriptedModern();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(clientTx);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        clientTx.close = () => Promise.reject(new Error('close blew up'));
        await expect(client.close()).rejects.toThrow('close blew up');
        // Per-connection state was cleared regardless.
        expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
    });
});

describe('_resetConnectionState() clears connection-scoped debounce timers (fake timers)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('a debounced listChanged callback armed on a closed connection never fires', async () => {
        const { clientTx, serverTx } = await scriptedModernNoAck();
        const calls: unknown[] = [];
        const client = new Client(
            { name: 'c', version: '1' },
            {
                versionNegotiation: { mode: 'auto' },
                listChanged: { tools: { onChanged: (e, items) => calls.push({ e, items }), autoRefresh: false, debounceMs: 100 } }
            }
        );
        const connecting = client.connect(clientTx);
        await vi.runAllTimersAsync();
        await connecting;
        // Arm the debounce timer for `tools` on the current connection.
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        await vi.advanceTimersByTimeAsync(0);
        expect((client as unknown as { _listChangedDebounceTimers: Map<unknown, unknown> })._listChangedDebounceTimers.size).toBe(1);
        // close() → _resetConnectionState() must clear the armed timer so the
        // callback for the dead connection never fires.
        await client.close();
        expect((client as unknown as { _listChangedDebounceTimers: Map<unknown, unknown> })._listChangedDebounceTimers.size).toBe(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(calls).toEqual([]);
    });
});

describe('Client.listen() — ack timeout (fake timers)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('ack timer firing rejects with RequestTimeout and tears the wire down', async () => {
        const { clientTx, written } = await scriptedModernNoAck();
        const client = new Client({ name: 'c', version: '1' }, { versionNegotiation: { mode: 'auto' } });
        const connecting = client.connect(clientTx);
        await vi.runAllTimersAsync();
        await connecting;
        const pending = client.listen({ toolsListChanged: true }, { timeout: 1000 });
        // Capture rejection to avoid an unhandled-rejection on the timer tick.
        const settled = pending.catch(e => e as SdkError);
        await vi.advanceTimersByTimeAsync(1000);
        const error = await settled;
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
        // wireTeardown sent notifications/cancelled referencing the listen id.
        const listenId = (written.find(m => (m as { method?: string }).method === 'subscriptions/listen') as { id: number | string }).id;
        const cancelled = written.find(m => (m as JSONRPCNotification).method === 'notifications/cancelled');
        expect(cancelled).toMatchObject({ params: { requestId: listenId } });
        // No leaked state.
        expect((client as unknown as { _listenState: Map<unknown, unknown> })._listenState.size).toBe(0);
        expect((client as unknown as { _responseHandlers: Map<unknown, unknown> })._responseHandlers.size).toBe(0);
        // Restore real timers before close to avoid hanging on transport timers.
        vi.useRealTimers();
        await client.close();
    });
});
