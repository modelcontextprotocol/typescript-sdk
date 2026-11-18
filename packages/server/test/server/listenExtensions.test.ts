/**
 * `listenExtensions` — extension fields of the `subscriptions/listen` filter
 * (for example the Tasks extension's `taskIds`) on both serving entries.
 *
 * Covers: the extension's honored fields in the ack and on the subscription
 * record, delivery of extension events filtered per subscription, core
 * capability narrowing that an extension cannot undo, a throwing `honor()`
 * (ack without its fields, core still served, its events not delivered,
 * reported), `validate()` rejecting with -32602, and stdio routing of an
 * instance's extension notifications.
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, Transport } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import type { ListenExtension } from '../../src/server/serverEventBus';
import { serveStdio } from '../../src/server/serveStdio';

const MODERN_REVISION = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'listen-extensions-test', version: '1' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};
const TASK_STATUS = 'notifications/tasks/status';

/** A Tasks-style extension: honors `taskIds`, delivers status events for those tasks. */
function tasksExtension(overrides: Partial<ListenExtension> = {}): ListenExtension {
    return {
        name: 'tasks',
        methods: [TASK_STATUS],
        validate: requested =>
            requested.taskIds === undefined || (Array.isArray(requested.taskIds) && requested.taskIds.every(id => typeof id === 'string'))
                ? undefined
                : "'taskIds' must be an array of strings",
        honor: requested => {
            const taskIds = requested.taskIds;
            return Array.isArray(taskIds) && taskIds.length > 0 ? { taskIds: [...(taskIds as string[])] } : undefined;
        },
        accepts: (honored, event) => (honored.taskIds as string[]).includes(event.params?.taskId as string),
        ...overrides
    };
}

function listenBody(id: string | number, filter: Record<string, unknown>): JSONRPCRequest {
    return { jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: ENVELOPE, notifications: filter } };
}

function listenRequest(id: string | number, filter: Record<string, unknown>): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN_REVISION,
            'mcp-method': 'subscriptions/listen'
        },
        body: JSON.stringify(listenBody(id, filter))
    });
}

/** Incremental SSE reader: `next()` resolves with the next `event: message` payload. */
function sseReader(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const queued: unknown[] = [];
    return {
        async next(): Promise<unknown> {
            while (queued.length === 0) {
                const { done, value } = await reader.read();
                if (done) return undefined;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
                    if (dataLine) queued.push(JSON.parse(dataLine.slice(6)));
                }
            }
            return queued.shift();
        },
        cancel: () => reader.cancel()
    };
}

function httpHandler(listenExtensions: ListenExtension[], errors: Error[] = [], capabilities?: Record<string, unknown>) {
    return createMcpHandler(
        () =>
            new McpServer(
                { name: 'listen-extensions-server', version: '1' },
                { capabilities: capabilities ?? { tools: { listChanged: true }, prompts: { listChanged: true } } }
            ),
        { keepAliveMs: 0, listenExtensions, onerror: error => errors.push(error) }
    );
}

describe('createMcpHandler — listenExtensions', () => {
    it('acks the extension fields and delivers extension events only for the honored task ids', async () => {
        const handler = httpHandler([tasksExtension()]);
        const stream = sseReader(await handler.fetch(listenRequest(1, { toolsListChanged: true, taskIds: ['t1'] })));
        expect(await stream.next()).toEqual({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 1 }, notifications: { toolsListChanged: true, taskIds: ['t1'] } }
        });

        handler.notify.extension(TASK_STATUS, { taskId: 't2', status: 'working' });
        handler.notify.extension('notifications/unclaimed', { taskId: 't1' });
        handler.notify.extension(TASK_STATUS, { taskId: 't1', status: 'completed' });
        handler.notify.toolsChanged();

        expect(await stream.next()).toEqual({
            jsonrpc: '2.0',
            method: TASK_STATUS,
            params: { taskId: 't1', status: 'completed', _meta: { [SUBSCRIPTION_ID_META_KEY]: 1 } }
        });
        expect((await stream.next()) as { method: string }).toMatchObject({ method: 'notifications/tools/list_changed' });
        await stream.cancel();
        await handler.close();
    });

    it('keeps a stream open on extension fields alone', async () => {
        const handler = httpHandler([tasksExtension()]);
        const stream = sseReader(await handler.fetch(listenRequest('only-tasks', { taskIds: ['t1'] })));
        expect(await stream.next()).toMatchObject({ params: { notifications: { taskIds: ['t1'] } } });
        handler.notify.extension(TASK_STATUS, { taskId: 't1' });
        expect(await stream.next()).toMatchObject({ method: TASK_STATUS, params: { taskId: 't1' } });
        await stream.cancel();
        await handler.close();
    });

    it('does not let an extension honor a core field the capabilities deny', async () => {
        const errors: Error[] = [];
        const greedy = tasksExtension({
            name: 'greedy',
            honor: requested => ({ resourcesListChanged: true, taskIds: requested.taskIds })
        });
        const handler = httpHandler([greedy], errors);
        const stream = sseReader(await handler.fetch(listenRequest(2, { resourcesListChanged: true, taskIds: ['t1'] })));
        expect(await stream.next()).toMatchObject({ params: { notifications: { taskIds: ['t1'] } } });
        expect(errors.map(e => e.message)).toEqual([
            "subscriptions/listen: extension 'greedy' cannot honor 'resourcesListChanged'; the field is dropped"
        ]);
        await stream.cancel();
        await handler.close();
    });

    it('a throwing honor() drops its fields from the ack and the record, serves core, and reports', async () => {
        const errors: Error[] = [];
        const broken = tasksExtension({
            name: 'broken',
            honor: () => {
                throw new Error('boom');
            }
        });
        const handler = httpHandler([broken], errors);
        const stream = sseReader(await handler.fetch(listenRequest(3, { toolsListChanged: true, taskIds: ['t1'] })));
        expect(await stream.next()).toMatchObject({ params: { notifications: { toolsListChanged: true } } });
        expect(errors.map(e => e.message)).toEqual([
            "subscriptions/listen: extension 'broken' honor() threw; its fields are not honored: boom"
        ]);

        // Its events are not delivered on this subscription; core events are.
        handler.notify.extension(TASK_STATUS, { taskId: 't1' });
        handler.notify.toolsChanged();
        expect(await stream.next()).toMatchObject({ method: 'notifications/tools/list_changed' });
        await stream.cancel();
        await handler.close();
    });

    it('rejects a malformed extension field with -32602 before the ack', async () => {
        const handler = httpHandler([tasksExtension()]);
        const response = await handler.fetch(listenRequest(4, { toolsListChanged: true, taskIds: 'not-an-array' }));
        expect(await response.json()).toEqual({
            jsonrpc: '2.0',
            id: 4,
            error: { code: -32_602, message: "Invalid params: 'taskIds' must be an array of strings" }
        });
        await handler.close();
    });

    it('refuses an extension that declares a core notification or a method another extension declares', () => {
        expect(() => httpHandler([tasksExtension({ methods: ['notifications/tools/list_changed'] })])).toThrow(
            "listenExtensions: extension 'tasks' cannot declare the core notification notifications/tools/list_changed"
        );
        expect(() => httpHandler([tasksExtension(), tasksExtension({ name: 'copy' })])).toThrow(
            `listenExtensions: ${TASK_STATUS} is declared by both 'tasks' and 'copy'`
        );
    });

    it('without listenExtensions, unknown filter fields are still dropped from the ack', async () => {
        const handler = httpHandler([]);
        const stream = sseReader(await handler.fetch(listenRequest(5, { toolsListChanged: true, taskIds: ['t1'] })));
        expect(await stream.next()).toMatchObject({ params: { notifications: { toolsListChanged: true } } });
        await stream.cancel();
        await handler.close();
    });
});

describe('serveStdio — listenExtensions', () => {
    async function bootModern(listenExtensions: ListenExtension[]) {
        const [peerTx, wireTx] = InMemoryTransport.createLinkedPair();
        const inbound: JSONRPCMessage[] = [];
        peerTx.onmessage = m => inbound.push(m);
        await peerTx.start();

        let server!: McpServer;
        const handle = serveStdio(
            () => {
                server = new McpServer({ name: 's', version: '1' });
                server.registerTool('a', { inputSchema: z.object({}) }, async () => ({ content: [] }));
                return server;
            },
            { transport: wireTx as Transport, listenExtensions }
        );
        await peerTx.send({ jsonrpc: '2.0', id: 'pin', method: 'tools/list', params: { _meta: ENVELOPE } });
        await new Promise(r => setTimeout(r, 10));
        inbound.length = 0;
        const flush = () => new Promise(r => setTimeout(r, 10));
        const send = (m: JSONRPCRequest | JSONRPCNotification) => peerTx.send(m);
        return { handle, server: () => server, inbound, send, flush };
    }

    it("acks the extension fields and routes the instance's extension notifications per subscription", async () => {
        const { handle, server, inbound, send, flush } = await bootModern([tasksExtension()]);
        await send(listenBody(1, { taskIds: ['t1'] }));
        await send(listenBody(2, { taskIds: ['t2'] }));
        await flush();
        expect(inbound).toEqual([
            {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 1 }, notifications: { taskIds: ['t1'] } }
            },
            {
                jsonrpc: '2.0',
                method: 'notifications/subscriptions/acknowledged',
                params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: 2 }, notifications: { taskIds: ['t2'] } }
            }
        ]);
        inbound.length = 0;

        await server().server.notification({ method: TASK_STATUS, params: { taskId: 't2', status: 'working' } });
        await server().server.notification({ method: TASK_STATUS, params: { taskId: 't3', status: 'working' } });
        await flush();
        expect(inbound).toEqual([
            {
                jsonrpc: '2.0',
                method: TASK_STATUS,
                params: { taskId: 't2', status: 'working', _meta: { [SUBSCRIPTION_ID_META_KEY]: 2 } }
            }
        ]);
        await handle.close();
    });

    it('a throwing honor() acks core only and its notifications are not delivered', async () => {
        const broken = tasksExtension({
            honor: () => {
                throw new Error('boom');
            }
        });
        const { handle, server, inbound, send, flush } = await bootModern([broken]);
        await send(listenBody(1, { toolsListChanged: true, taskIds: ['t1'] }));
        await flush();
        expect(inbound).toHaveLength(1);
        expect((inbound[0] as JSONRPCNotification).params?.notifications).toEqual({ toolsListChanged: true });
        inbound.length = 0;
        await server().server.notification({ method: TASK_STATUS, params: { taskId: 't1' } });
        server().sendToolListChanged();
        await flush();
        expect(inbound.map(m => (m as JSONRPCNotification).method)).toEqual(['notifications/tools/list_changed']);
        await handle.close();
    });

    it('rejects a malformed extension field with -32602', async () => {
        const { handle, inbound, send, flush } = await bootModern([tasksExtension()]);
        await send(listenBody(9, { taskIds: [1, 2] }));
        await flush();
        expect(inbound).toEqual([
            { jsonrpc: '2.0', id: 9, error: { code: -32_602, message: "Invalid params: 'taskIds' must be an array of strings" } }
        ]);
        await handle.close();
    });
});
