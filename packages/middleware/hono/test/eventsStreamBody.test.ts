/**
 * What an open `events/stream` keeps of its request body under `createMcpHonoApp`, whose body
 * parser reads a clone and leaves the original's body unread: none of it, while a client abort
 * still ends the stream.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import type { Context } from 'hono';
import { vi } from 'vitest';

import { createMcpHonoApp } from '../src/hono';

const MODERN = '2026-07-28';
const NAME = 'tick';
const PADDING = 4_000_000;
const CHUNK = 65_536;
const STREAMS = 3;
const HEADERS = {
    host: 'localhost',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN,
    'mcp-method': 'events/stream',
    'mcp-name': NAME
};
const MESSAGE = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'events/stream',
    params: {
        name: NAME,
        _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'stream-client', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } }
        }
    }
});

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

// An events/stream Request whose streamed body ends in `padding` spaces, each chunk freshly allocated as a network body's are.
function paddedRequest(padding: number, signal: AbortSignal): Request {
    let left = padding;
    let sentMessage = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!sentMessage) {
                sentMessage = true;
                controller.enqueue(new TextEncoder().encode(MESSAGE));
            } else if (left > 0) {
                const size = Math.min(left, CHUNK);
                left -= size;
                controller.enqueue(new Uint8Array(size).fill(0x20));
            } else {
                controller.close();
            }
        }
    });
    return new Request('http://localhost/mcp', { method: 'POST', headers: HEADERS, body, duplex: 'half', signal });
}

// The memory in use after collecting garbage, each pass in a fresh task: the V8 heap and `external`, where `ArrayBuffer` chunks live.
async function memoryUsed(): Promise<number> {
    for (let pass = 0; pass < 3; pass++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        gc();
    }
    const { heapUsed, external } = process.memoryUsage();
    return heapUsed + external;
}

test('keeps none of the body of an events/stream padded with 4 MB of JSON whitespace while it is open, and a client abort still ends it', async () => {
    let ended = 0;
    const events = new EventsExtension();
    events.registerEvent(NAME, {
        emitOnly: true,
        inputSchema: fromJsonSchema({ type: 'object' }),
        payloadSchema: fromJsonSchema({ type: 'object' }),
        onUnsubscribe: () => {
            ended += 1;
        }
    });
    const handler = createMcpHandler(() => new McpServer({ name: 'stream-body', version: '1.0.0' }, { extensions: [events] }));
    const app = createMcpHonoApp();
    app.all('/mcp', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
    const aborts: AbortController[] = [];

    // Resolves at `notifications/events/active`; the response is drained from then on.
    const openStream = async (padding: number): Promise<AbortController> => {
        const controller = new AbortController();
        aborts.push(controller);
        const response = await app.fetch(paddedRequest(padding, controller.signal));
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (!text.includes('notifications/events/active')) {
            const { done, value } = await reader.read();
            if (done) throw new Error(`the stream ended before active: ${text}`);
            text += decoder.decode(value, { stream: true });
        }
        reader.releaseLock();
        void response.body!.pipeTo(new WritableStream()).catch(() => {});
        return controller;
    };

    try {
        for (let count = 0; count < STREAMS; count++) await openStream(0);
        const before = await memoryUsed();

        const padded: AbortController[] = [];
        for (let count = 0; count < STREAMS; count++) padded.push(await openStream(PADDING));

        // Three bodies kept would be about 12 MB.
        expect((await memoryUsed()) - before).toBeLessThan(PADDING);

        for (const controller of padded) controller.abort();
        await vi.waitFor(() => expect(ended).toBe(STREAMS));
    } finally {
        for (const controller of aborts) controller.abort();
        await handler.close();
    }
});
