/**
 * Graceful close — opt-in drain of in-flight requests (issue #1231).
 *
 * `close({ drainPendingRequests })` waits for in-flight requests to settle
 * before the transport closes, so a completed-but-still-reading HTTP response
 * is not torn down by the transport's abort (which OpenTelemetry's undici
 * instrumentation reports as UND_ERR_ABORTED on a 200 OK). Default close
 * behavior is unchanged.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';

const flush = () => new Promise(r => setTimeout(r, 10));

type ScriptedServer = {
    clientTx: InMemoryTransport;
    serverTx: InMemoryTransport;
    written: JSONRPCMessage[];
    /** Replies to the oldest outstanding non-initialize request. */
    reply: (result: Record<string, unknown>) => void;
    /** Replies to the oldest outstanding non-initialize request on a delay. */
    replyAfter: (ms: number, result: Record<string, unknown>) => Promise<void>;
};

/**
 * A linked in-memory pair where the server auto-answers the legacy
 * `initialize` handshake (so `connect()` resolves) but holds every other
 * request until the test calls `reply()` / `replyAfter()`.
 */
async function scriptedLegacyServer(): Promise<ScriptedServer> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const written: JSONRPCMessage[] = [];
    const pendingIds: (number | string)[] = [];
    serverTx.onmessage = message => {
        written.push(message);
        const req = message as { id?: number | string; method?: string; params?: { protocolVersion?: string } };
        if (req.method === 'initialize' && req.id !== undefined) {
            void serverTx.send({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
                    capabilities: {},
                    serverInfo: { name: 'scripted', version: '1' }
                }
            });
            return;
        }
        if (req.method === 'notifications/initialized') {
            return;
        }
        if (req.id !== undefined) {
            pendingIds.push(req.id);
        }
    };
    await serverTx.start();
    const reply = (result: Record<string, unknown>) => {
        const id = pendingIds.shift();
        if (id === undefined) {
            throw new Error('no pending request to reply to');
        }
        void serverTx.send({ jsonrpc: '2.0', id, result });
    };
    return {
        clientTx,
        serverTx,
        written,
        reply,
        replyAfter: async (ms: number, result: Record<string, unknown>) => {
            await new Promise(r => setTimeout(r, ms));
            reply(result);
        }
    };
}

async function connectClient(options?: ConstructorParameters<typeof Client>[1]): Promise<{ client: Client; server: ScriptedServer }> {
    const server = await scriptedLegacyServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, options);
    await client.connect(server.clientTx);
    return { client, server };
}

/** Spies on the client transport's close() without changing behavior. */
function spyTransportClose(client: Client): { closed: () => boolean } {
    let closed = false;
    const transport = client.transport!;
    const originalClose = transport.close.bind(transport);
    transport.close = async () => {
        closed = true;
        await originalClose();
    };
    return { closed: () => closed };
}

describe('Client.close graceful drain', () => {
    it('default close() is unchanged: transport closes with a request in flight', async () => {
        const { client } = await connectClient();
        const inFlight = client.request({ method: 'ping' }).catch(e => e);
        await flush();
        await client.close();
        const settled = (await inFlight) as Error;
        // The request is settled by the close itself, not by a response.
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toMatch(/closed/i);
    });

    it('close({ drainPendingRequests: true }) waits for the in-flight response before closing', async () => {
        const { client, server } = await connectClient();
        let settled: unknown;
        const inFlight = client
            .request({ method: 'ping' })
            .then(r => (settled = r))
            .catch(e => (settled = e));
        await flush();

        const spy = spyTransportClose(client);
        const closing = client.close({ drainPendingRequests: true });

        // The transport must still be open while the request is outstanding.
        await flush();
        expect(spy.closed()).toBe(false);

        // The response lands on the still-open connection; the drain then
        // completes and the transport closes.
        await server.replyAfter(20, {});
        await inFlight;
        await closing;
        expect(spy.closed()).toBe(true);
        expect(settled).toBeDefined();
    });

    it('multiple in-flight requests all drain before the transport closes', async () => {
        const { client, server } = await connectClient();
        const first = client.request({ method: 'ping' }).catch(e => e);
        const second = client.request({ method: 'ping' }).catch(e => e);
        await flush();

        const spy = spyTransportClose(client);
        const closing = client.close({ drainPendingRequests: true });
        await flush();
        expect(spy.closed()).toBe(false);

        server.reply({});
        await first;
        await flush();
        // One of two requests still outstanding: no close yet.
        expect(spy.closed()).toBe(false);

        server.reply({});
        await second;
        await closing;
        expect(spy.closed()).toBe(true);
    });

    it('falls back to a hard close after the drain timeout and requests settle with the close', async () => {
        const { client } = await connectClient();
        const inFlight = client.request({ method: 'ping' }).catch(e => e);
        await flush();

        await client.close({ drainPendingRequests: { timeoutMs: 30 } });
        const settled = (await inFlight) as Error;
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toMatch(/closed/i);
    });

    it('drain resolves immediately when nothing is in flight', async () => {
        const { client } = await connectClient();
        const start = Date.now();
        await client.close({ drainPendingRequests: true });
        expect(Date.now() - start).toBeLessThan(500);
    });

    it('ClientOptions.gracefulClose applies to parameterless close()', async () => {
        const { client, server } = await connectClient({ gracefulClose: true });
        const inFlight = client.request({ method: 'ping' }).catch(e => e);
        await flush();

        const spy = spyTransportClose(client);
        const closing = client.close();
        await flush();
        expect(spy.closed()).toBe(false);

        await server.replyAfter(20, {});
        await inFlight;
        await closing;
        expect(spy.closed()).toBe(true);
    });

    it('an explicit close({ drainPendingRequests: false }) overrides the constructor default', async () => {
        const { client } = await connectClient({ gracefulClose: true });
        const inFlight = client.request({ method: 'ping' }).catch(e => e);
        await flush();

        const spy = spyTransportClose(client);
        await client.close({ drainPendingRequests: false });
        expect(spy.closed()).toBe(true);
        const settled = (await inFlight) as Error;
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toMatch(/closed/i);
    });
});
