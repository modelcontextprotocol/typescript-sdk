/**
 * `createListenRouter` — abort wiring for a listen stream that has already completed.
 *
 * When nothing is honored, `ReadableStream.start()` tears the stream down synchronously, so
 * by the time the request-signal wiring runs the subscription is closed. Registering `onAbort`
 * anyway strands a listener on the caller's signal: `teardown()` returns early once `closed`
 * is set, so its `abortCleanup` never runs, and `closeAll()` cannot reach it either (the
 * teardown is already out of the open set). One live signal serving many completed listens —
 * the shape of a shared per-connection signal — therefore grows a listener per request.
 */
import { getEventListeners } from 'node:events';
import type { JSONRPCRequest, ServerCapabilities } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { createListenRouter } from '../../src/server/listenRouter';
import { InMemoryServerEventBus } from '../../src/server/serverEventBus';

const SERVER_INFO = { name: 'listen-abort-test', version: '1' };

function listenRequest(id: number, filter: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { notifications: filter } };
}

/** Capabilities that advertise nothing, so any requested filter is narrowed to empty. */
const NO_CAPABILITIES: ServerCapabilities = {};
/** Capabilities that advertise `tools.listChanged`, so an empty request honors nothing. */
const TOOLS_LIST_CHANGED: ServerCapabilities = { tools: { listChanged: true } };

describe('createListenRouter — completed listens do not retain abort listeners', () => {
    it('attaches no abort listener when capabilities narrow the filter to nothing', async () => {
        const signal = new AbortController().signal;
        const bus = new InMemoryServerEventBus();
        const router = createListenRouter({ bus, keepAliveMs: 0 });

        for (let id = 1; id <= 3; id++) {
            const response = router.serve(listenRequest(id, { toolsListChanged: true }), signal, NO_CAPABILITIES, SERVER_INFO);
            await expect(response.text()).resolves.toContain('"resultType":"complete"');
            expect(router.openCount).toBe(0);
            expect(bus.listenerCount).toBe(0);
            expect(getEventListeners(signal, 'abort')).toHaveLength(0);
        }

        router.closeAll();
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    it('attaches no abort listener when the requested filter is empty', async () => {
        const signal = new AbortController().signal;
        const router = createListenRouter({ bus: new InMemoryServerEventBus(), keepAliveMs: 0 });

        const response = router.serve(listenRequest(7, {}), signal, TOOLS_LIST_CHANGED, SERVER_INFO);
        await expect(response.text()).resolves.toContain('"resultType":"complete"');
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);

        router.closeAll();
        expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    it('still wires and releases the abort listener for a stream that stays open', async () => {
        const controller = new AbortController();
        const bus = new InMemoryServerEventBus();
        const router = createListenRouter({ bus, keepAliveMs: 0 });

        const response = router.serve(listenRequest(9, { toolsListChanged: true }), controller.signal, TOOLS_LIST_CHANGED, SERVER_INFO);
        expect(router.openCount).toBe(1);
        expect(bus.listenerCount).toBe(1);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

        controller.abort();
        expect(router.openCount).toBe(0);
        expect(bus.listenerCount).toBe(0);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

        await response.text();
    });
});
