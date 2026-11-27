/**
 * What an open `events/stream` keeps of its HTTP request body through `createMcpHandler.fetch`:
 * nothing still unread, whether the host read a clone and passed `parsedBody` (Hono's pattern)
 * or the handler read the body itself, while a client abort still ends the stream.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import { afterEach, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

const MODERN = '2026-07-28';
const NAME = 'tick';
const PADDING = 4_000_000;
const CHUNK = 65_536;
const STREAMS = 3;
const HEADERS = {
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

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
});

// One emit-only event type; `onUnsubscribe` counts the streams that ended.
function served(): { handler: McpHttpHandler; ended: () => number } {
    let ended = 0;
    const events = new EventsExtension();
    events.registerEvent(NAME, {
        emitOnly: true,
        inputSchema: z.object({}),
        payloadSchema: z.object({}),
        onUnsubscribe: () => {
            ended += 1;
        }
    });
    const handler = createMcpHandler(() => new McpServer({ name: 'stream-request', version: '1.0.0' }, { extensions: [events] }));
    cleanups.push(() => handler.close());
    return { handler, ended: () => ended };
}

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

// Opens a stream through `handler.fetch`, resolving at `notifications/events/active`; the response is drained from then on.
async function openStream(handler: McpHttpHandler, padding: number, parsedBodyFromClone: boolean): Promise<{ abort(): void }> {
    const controller = new AbortController();
    const request = paddedRequest(padding, controller.signal);
    // Hono's pattern: the body parser reads a clone to the end and the original is handed on with `parsedBody`.
    const response = parsedBodyFromClone
        ? await handler.fetch(request, { parsedBody: JSON.parse(await request.clone().text()) as unknown })
        : await handler.fetch(request);
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
    cleanups.push(() => controller.abort());
    return { abort: () => controller.abort() };
}

// The memory in use after collecting garbage, each pass in a fresh task: the V8 heap and `external`, where `ArrayBuffer` chunks and large decoded strings live.
async function memoryUsed(): Promise<number> {
    for (let pass = 0; pass < 3; pass++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        gc();
    }
    const { heapUsed, external } = process.memoryUsage();
    return heapUsed + external;
}

it.each([
    ['a host that read a clone and passed parsedBody', true],
    ['the handler reading the body itself', false]
])(
    'keeps none of the body of an events/stream padded with 4 MB of JSON whitespace while it is open, with %s, and a client abort still ends it',
    async (_label, parsedBodyFromClone) => {
        const { handler, ended } = served();
        for (let count = 0; count < STREAMS; count++) await openStream(handler, 0, parsedBodyFromClone);
        const before = await memoryUsed();

        const padded: Array<{ abort(): void }> = [];
        for (let count = 0; count < STREAMS; count++) padded.push(await openStream(handler, PADDING, parsedBodyFromClone));

        // Three bodies kept would be about 12 MB.
        expect((await memoryUsed()) - before).toBeLessThan(PADDING);

        for (const stream of padded) stream.abort();
        await vi.waitFor(() => expect(ended()).toBe(STREAMS));
    }
);
