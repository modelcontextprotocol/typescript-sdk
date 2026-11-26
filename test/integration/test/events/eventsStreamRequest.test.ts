/**
 * What an open `events/stream` keeps of its HTTP request under `toNodeHandler`:
 * none of its body once read, while a client disconnect still ends the stream.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

const MODERN = '2026-07-28';
const NAME = 'tick';
const PADDING = 4_000_000;
// The client writes the padding from this one chunk.
const SPACES = Buffer.alloc(65_536, 0x20);
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

async function serveNode(handler: McpHttpHandler): Promise<URL> {
    const httpServer: HttpServer = createServer(toNodeHandler(handler));
    const baseUrl = await listenOnRandomPort(httpServer);
    cleanups.push(() => void httpServer.close());
    return baseUrl;
}

// Opens an events/stream whose body ends in `padding` spaces, written from one reused chunk so the client keeps no copy of the body; resolves at `notifications/events/active` with a disconnect.
function openStream(baseUrl: URL, padding: number): Promise<{ status: number | undefined; disconnect(): void }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            new URL('/mcp', baseUrl),
            { method: 'POST', headers: { ...HEADERS, 'content-length': Buffer.byteLength(MESSAGE) + padding } },
            response => {
                let text = '';
                response.setEncoding('utf8');
                const read = (chunk: string): void => {
                    text += chunk;
                    if (!text.includes('notifications/events/active')) return;
                    response.off('data', read);
                    response.resume();
                    resolve({ status: response.statusCode, disconnect: () => request.destroy() });
                };
                response.on('data', read);
                response.on('end', () => reject(new Error(`the stream ended before active: ${text}`)));
            }
        );
        request.on('error', () => {});
        request.write(MESSAGE);
        for (let left = padding; left > 0; left -= SPACES.byteLength)
            request.write(left < SPACES.byteLength ? SPACES.subarray(0, left) : SPACES);
        request.end();
        cleanups.push(() => void request.destroy());
    });
}

// The memory in use after collecting garbage, each pass in a fresh task: the V8 heap and `ArrayBuffer` backing stores, where a body kept as bytes lives.
async function memoryUsed(): Promise<number> {
    for (let pass = 0; pass < 3; pass++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        gc();
    }
    return getHeapStatistics().used_heap_size + process.memoryUsage().arrayBuffers;
}

it('keeps none of the body of an events/stream padded with 4 MB of JSON whitespace while it is open, and a client disconnect still ends it, under toNodeHandler', async () => {
    const { handler, ended } = served();
    const baseUrl = await serveNode(handler);
    for (let count = 0; count < 3; count++) await openStream(baseUrl, 0);
    const before = await memoryUsed();

    const padded: Array<{ disconnect(): void }> = [];
    for (let count = 0; count < 3; count++) {
        const stream = await openStream(baseUrl, PADDING);
        expect(stream.status).toBe(200);
        padded.push(stream);
    }

    // Three bodies kept would be about 12 MB.
    expect((await memoryUsed()) - before).toBeLessThan(PADDING);

    for (const stream of padded) stream.disconnect();
    await vi.waitFor(() => expect(ended()).toBe(3));
});
