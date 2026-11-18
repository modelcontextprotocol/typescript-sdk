/**
 * `clientInternals.openStream`: the package-internal long-lived request (no timeout, `stream:N` ids, frames routed by
 * the subscription id in `_meta`) that the Events client's push mode opens `events/stream` with.
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, TransportSendOptions } from '@modelcontextprotocol/core-internal';
import {
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { StreamEnd } from '../../src/client/client';
import { Client, clientInternals } from '../../src/client/client';

const MODERN = '2026-07-28';
const EVENT = 'notifications/events/event';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** A scripted 2026-07-28 server: answers `server/discover`, records every other message and never answers it. */
async function scriptedServer() {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const received: JSONRPCMessage[] = [];
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        if (request.method === 'server/discover') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: [MODERN],
                    capabilities: {},
                    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted', version: '1.0.0' } }
                }
            });
            return;
        }
        received.push(message);
    };
    await serverTx.start();
    const frame = (subscriptionId: string, params: Record<string, unknown> = {}) =>
        serverTx.send({ jsonrpc: '2.0', method: EVENT, params: { ...params, _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } } });
    return { clientTx, serverTx, received, frame };
}

async function scriptedStreams() {
    const server = await scriptedServer();
    const client = new Client({ name: 'stream-test-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(server.clientTx);
    return { client, ...server };
}

function recorder() {
    const notifications: JSONRPCNotification[] = [];
    const ends: StreamEnd[] = [];
    return {
        notifications,
        ends,
        handlers: {
            onNotification: (notification: JSONRPCNotification) => void notifications.push(notification),
            onEnd: (end: StreamEnd) => void ends.push(end)
        }
    };
}

const streamRequest = (name: string) => ({ method: 'events/stream', params: { name, arguments: {}, cursor: null } });

function sendOptions(send: { mock: { calls: unknown[][] } }, id: string): TransportSendOptions {
    const call = send.mock.calls.find(([message]) => (message as { id?: unknown }).id === id);
    return call![1] as TransportSendOptions;
}

describe('clientInternals.openStream', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('routes notifications to the stream that owns the id', async () => {
        const { client, received, frame } = await scriptedStreams();
        const global: unknown[] = [];
        client.setNotificationHandler(EVENT, { params: z.looseObject({}) }, params => void global.push(params));
        const first = recorder();
        const second = recorder();

        const a = clientInternals.openStream(client, streamRequest('a'), first.handlers);
        const b = clientInternals.openStream(
            client,
            { method: 'events/stream', params: { name: 'b', _meta: { 'example.com/trace': 't1' } } },
            second.handlers
        );

        expect([a.id, b.id]).toEqual(['stream:0', 'stream:1']);
        expect(received).toMatchObject([
            { id: 'stream:0', method: 'events/stream', params: { name: 'a', _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN } } },
            {
                id: 'stream:1',
                method: 'events/stream',
                params: { name: 'b', _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN, 'example.com/trace': 't1' } }
            }
        ]);

        await frame('stream:1', { eventId: 'e1' });
        await frame('stream:7', { eventId: 'e2' });
        await flush();
        expect(first.notifications).toEqual([]);
        expect(second.notifications).toMatchObject([
            { method: EVENT, params: { eventId: 'e1', _meta: { [SUBSCRIPTION_ID_META_KEY]: 'stream:1' } } }
        ]);
        // Only the frame no live stream owns reaches the global handler.
        expect(global).toMatchObject([{ eventId: 'e2' }]);
        await client.close();
    });

    it('arms no timeout', async () => {
        const { client, frame } = await scriptedStreams();
        vi.useFakeTimers();
        const stream = recorder();

        clientInternals.openStream(client, streamRequest('a'), stream.handlers);

        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(stream.ends).toEqual([]);
        await frame('stream:0', { eventId: 'e1' });
        expect(stream.notifications).toHaveLength(1);
        vi.useRealTimers();
        await client.close();
    });

    it('ends gracefully on a result and remotely on an error response', async () => {
        const { client, serverTx } = await scriptedStreams();
        const graceful = recorder();
        const failed = recorder();
        clientInternals.openStream(client, streamRequest('a'), graceful.handlers);
        clientInternals.openStream(client, streamRequest('b'), failed.handlers);
        const result = { resultType: 'complete', _meta: { [SUBSCRIPTION_ID_META_KEY]: 'stream:0' } };

        await serverTx.send({ jsonrpc: '2.0', id: 'stream:0', result });
        await serverTx.send({ jsonrpc: '2.0', id: 'stream:1', error: { code: -32_024, message: 'Forbidden' } });

        expect(graceful.ends).toEqual([{ cause: 'graceful', result }]);
        expect(failed.ends).toEqual([{ cause: 'remote', error: expect.any(ProtocolError) }]);
        expect(failed.ends).toEqual([{ cause: 'remote', error: expect.objectContaining({ code: -32_024 }) }]);
        await client.close();
        expect(graceful.ends).toHaveLength(1);
        expect(failed.ends).toHaveLength(1);
    });

    it('cancels with notifications/cancelled on close()', async () => {
        const { client, clientTx, received, frame } = await scriptedStreams();
        const send = vi.spyOn(clientTx, 'send');
        const ends: StreamEnd[] = [];
        let sentBeforeEnd: JSONRPCMessage[] = [];
        const handle = clientInternals.openStream(client, streamRequest('a'), {
            onNotification: () => {},
            onEnd: end => {
                ends.push(end);
                sentBeforeEnd = [...received];
            }
        });
        const signal = sendOptions(send, 'stream:0').requestSignal!;
        received.length = 0;

        await handle.close();

        expect(signal.aborted).toBe(true);
        expect(received).toMatchObject([
            { method: 'notifications/cancelled', params: { requestId: 'stream:0', _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN } } }
        ]);
        expect(ends).toEqual([{ cause: 'local' }]);
        expect(sentBeforeEnd).toEqual(received);
        await handle.close();
        await frame('stream:0', { eventId: 'late' });
        expect(received).toHaveLength(1);
        expect(ends).toHaveLength(1);
        await client.close();
    });

    it('ends remotely when the transport closes', async () => {
        const { client, clientTx } = await scriptedStreams();
        const stream = recorder();
        const handle = clientInternals.openStream(client, streamRequest('a'), stream.handlers);

        await clientTx.close();

        expect(stream.ends).toStrictEqual([{ cause: 'remote' }]);
        await handle.close();
        await client.close();
        expect(stream.ends).toHaveLength(1);
    });

    it('does not loop when onEnd reopens synchronously on transport close', async () => {
        const { client, clientTx } = await scriptedStreams();
        const ends: StreamEnd[] = [];
        const refused: unknown[] = [];
        let opens = 0;
        const open = (): void => {
            try {
                clientInternals.openStream(client, streamRequest('a'), {
                    onNotification: () => {},
                    onEnd: end => {
                        ends.push(end);
                        // Capped so a regression fails the assertions below instead of hanging the run.
                        if (ends.length < 20) open();
                    }
                });
                opens++;
            } catch (error) {
                refused.push(error);
            }
        };
        open();

        await clientTx.close();
        await flush();

        // The reopen inside the teardown is sent on the closing transport and ends when that send fails; the next is refused.
        expect(opens).toBe(2);
        expect(ends).toHaveLength(2);
        expect(ends[0]).toStrictEqual({ cause: 'remote' });
        expect(ends[1]).toMatchObject({ cause: 'remote', error: expect.objectContaining({ code: SdkErrorCode.NotConnected }) });
        expect(refused).toEqual([expect.objectContaining({ code: SdkErrorCode.NotConnected })]);
        await client.close();
    });

    it('a throwing onEnd on transport close still ends the other streams and pending requests', async () => {
        const { client, clientTx, received } = await scriptedStreams();
        const errors: Error[] = [];
        client.onerror = error => void errors.push(error);
        const failure = new Error('onEnd failed');
        clientInternals.openStream(client, streamRequest('a'), {
            onNotification: () => {},
            onEnd: () => {
                throw failure;
            }
        });
        const other = recorder();
        clientInternals.openStream(client, streamRequest('b'), other.handlers);
        const pending = client.request({ method: 'tools/list', params: {} });
        await flush();
        expect(received.map(message => (message as JSONRPCRequest).method)).toEqual(['events/stream', 'events/stream', 'tools/list']);

        await clientTx.close();

        expect(other.ends).toStrictEqual([{ cause: 'remote' }]);
        await expect(pending).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        expect(errors).toEqual([failure]);
        await client.close();
    });

    it('ends remotely when the request stream ends', async () => {
        const { client, clientTx } = await scriptedStreams();
        const send = vi.spyOn(clientTx, 'send');
        const stream = recorder();
        clientInternals.openStream(client, streamRequest('a'), stream.handlers);
        const options = sendOptions(send, 'stream:0');

        options.onRequestStreamEnd!();

        expect(stream.ends).toStrictEqual([{ cause: 'remote' }]);
        expect(options.requestSignal!.aborted).toBe(true);
        await client.close();
    });

    it('ends remotely when the client reconnects', async () => {
        const { client } = await scriptedStreams();
        const stream = recorder();
        clientInternals.openStream(client, streamRequest('a'), stream.handlers);

        await client.connect((await scriptedServer()).clientTx);

        expect(stream.ends).toStrictEqual([{ cause: 'remote' }]);
        await client.close();
    });

    it('ends remotely with the send error when the send fails', async () => {
        const { client, clientTx } = await scriptedStreams();
        const failure = new Error('send failed');
        clientTx.send = () => Promise.reject(failure);
        const stream = recorder();

        clientInternals.openStream(client, streamRequest('a'), stream.handlers);
        await flush();

        expect(stream.ends).toEqual([{ cause: 'remote', error: failure }]);
        await client.close();
    });

    it('passes per-request headers to the transport', async () => {
        const { client, clientTx } = await scriptedStreams();
        const send = vi.spyOn(clientTx, 'send');

        clientInternals.openStream(client, streamRequest('a'), recorder().handlers, { headers: { 'Mcp-Param-Region': 'eu-west-1' } });

        expect(sendOptions(send, 'stream:0').headers).toEqual({ 'Mcp-Param-Region': 'eu-west-1' });
        await client.close();
    });

    it('throws NotConnected when not connected', async () => {
        const client = new Client({ name: 'stream-test-client', version: '1.0.0' });
        const stream = recorder();

        let error: unknown;
        try {
            clientInternals.openStream(client, streamRequest('a'), stream.handlers);
        } catch (thrown) {
            error = thrown;
        }

        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.NotConnected);
        expect(stream.ends).toEqual([]);
    });
});
