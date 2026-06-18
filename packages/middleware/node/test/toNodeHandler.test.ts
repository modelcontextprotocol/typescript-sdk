/**
 * `toNodeHandler(handler)` — the Node `(req, res, parsedBody?)` adapter over a
 * web-standard `McpHttpHandler`. Covers the request-stream conversion, the
 * pre-parsed-body path (the documented `express.json()` mounting), `req.auth`
 * pass-through, HTTP/2 pseudo-header skipping, and write-backpressure pacing.
 *
 * These tests previously lived in `@modelcontextprotocol/server`'s
 * `createMcpHandler.test.ts` as the `.node` face tests; the body of the
 * adapter is unchanged, only its home moved.
 */
import { Readable } from 'node:stream';

import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { NodeServerResponseLike } from '../src/toNodeHandler.js';
import { toNodeHandler } from '../src/toNodeHandler.js';

const MODERN_REVISION = '2026-07-28';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'node-adapter-test-client', version: '3.2.1' },
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } }
};

function modernToolsCall(name: string, args: Record<string, unknown>): unknown {
    return {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, _meta: ENVELOPE }
    };
}

/** SEP-2243 standard headers a conformant client derives from a modern body. */
function bodyDerivedStandardHeaders(body: unknown): Record<string, string> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
    const b = body as { method?: unknown; params?: { name?: unknown; uri?: unknown; _meta?: Record<string, unknown> } };
    if (typeof b.params?._meta?.[PROTOCOL_VERSION_META_KEY] !== 'string') return {};
    const out: Record<string, string> = {};
    if (typeof b.method === 'string') out['mcp-method'] = b.method;
    const name = b.method === 'resources/read' ? b.params.uri : b.params.name;
    if (typeof name === 'string') out['mcp-name'] = name;
    return out;
}

function testFactory(): { factory: (ctx: McpRequestContext) => McpServer; contexts: McpRequestContext[] } {
    const contexts: McpRequestContext[] = [];
    const factory = (ctx: McpRequestContext): McpServer => {
        contexts.push(ctx);
        const mcpServer = new McpServer({ name: 'node-adapter-test-server', version: '1.0.0' });
        mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        mcpServer.registerTool('whoami', { inputSchema: z.object({}) }, async (_args, ctx2) => ({
            content: [{ type: 'text', text: ctx2.http?.authInfo?.clientId ?? 'anonymous' }]
        }));
        mcpServer.registerTool('progress-then-echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }, ctx2) => {
            await ctx2.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
            return { content: [{ type: 'text', text }] };
        });
        return mcpServer;
    };
    return { factory, contexts };
}

describe('toNodeHandler', () => {
    it('serves through the duck-typed Node adapter, reading the request stream when no parsed body is given', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const { req, res, body } = nodeRequestResponse(modernToolsCall('echo', { text: 'node face' }));
        // Express mounts pass `next` as the third argument; a function is never a parsed body.
        await node(req, res, () => {});
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node face');
    });

    it('prefers a pre-parsed body over the request stream', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const parsed = modernToolsCall('echo', { text: 'pre-parsed' });
        const { req, res, body } = nodeRequestResponse(undefined);
        Object.assign(req.headers, bodyDerivedStandardHeaders(parsed));
        await node(req, res, parsed);
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('pre-parsed');
    });

    it('serves a pre-parsed legacy body on the default fallback (the documented express.json mounting)', async () => {
        const { factory, contexts } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        // The documented Express mounting: express.json() consumed the stream
        // and hands the parsed object as the third argument; the raw headers
        // still describe the original (already-consumed) bytes.
        const legacyMessage = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'node legacy' } } };
        const { req, res, body } = nodeRequestResponse(undefined);
        req.headers['content-length'] = '999';
        req.headers['transfer-encoding'] = 'chunked';
        await node(req, res, legacyMessage);

        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node legacy');
        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.era).toBe('legacy');
    });

    it('forwards req.auth from upstream middleware as pass-through authInfo', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const { req, res, body } = nodeRequestResponse(modernToolsCall('whoami', {}));
        req.auth = { token: 'verified', clientId: 'node-client', scopes: [] };
        await node(req, res);
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node-client');
    });

    it('skips HTTP/2 pseudo-headers when copying node request headers', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const { req, res, body } = nodeRequestResponse(modernToolsCall('echo', { text: 'http2 served' }));
        Object.assign(req.headers, {
            ':method': 'POST',
            ':path': '/mcp',
            ':scheme': 'http',
            ':authority': 'localhost:3000'
        });
        await node(req, res);

        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('http2 served');
    });

    it('waits for drain before writing the next chunk when res.write reports backpressure', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const writes: string[] = [];
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const res: NodeServerResponseLike & { statusCode: number } = {
            statusCode: 0,
            writeHead(statusCode: number) {
                this.statusCode = statusCode;
                return this;
            },
            write(chunk: string | Uint8Array) {
                writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
                // Always report a full buffer.
                return false;
            },
            end() {
                return this;
            },
            on(event: string, listener: (...args: unknown[]) => void) {
                const existing = listeners.get(event) ?? [];
                existing.push(listener);
                listeners.set(event, existing);
                return this;
            }
        };
        const emitDrain = () => {
            for (const listener of listeners.get('drain') ?? []) {
                listener();
            }
        };

        // The default (auto) response mode streams this exchange over SSE, so
        // the loop sees at least two chunks (the progress frame and the result).
        const { req } = nodeRequestResponse(modernToolsCall('progress-then-echo', { text: 'paced' }));
        const served = node(req, res);

        await vi.waitFor(() => expect(writes.length).toBe(1));
        // With the buffer reported full and no drain yet, no further chunk is written.
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(writes).toHaveLength(1);

        // Draining releases the loop chunk by chunk until the stream completes.
        const pump = setInterval(emitDrain, 5);
        await served;
        clearInterval(pump);

        const streamed = writes.join('');
        expect(writes.length).toBeGreaterThan(1);
        expect(streamed).toContain('notifications/progress');
        expect(streamed).toContain('paced');
    });

    it('does not park on backpressure when the client closes without ever draining', async () => {
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        let writeCount = 0;
        const res: NodeServerResponseLike & { statusCode: number } = {
            statusCode: 0,
            writeHead(statusCode: number) {
                this.statusCode = statusCode;
                return this;
            },
            write() {
                writeCount += 1;
                // Always report a full buffer; 'drain' will never fire.
                return false;
            },
            end() {
                return this;
            },
            on(event: string, listener: (...args: unknown[]) => void) {
                const existing = listeners.get(event) ?? [];
                existing.push(listener);
                listeners.set(event, existing);
                return this;
            }
        };
        const emitClose = () => {
            for (const listener of listeners.get('close') ?? []) {
                listener();
            }
        };

        const { req } = nodeRequestResponse(modernToolsCall('progress-then-echo', { text: 'gone' }));
        const served = node(req, res);

        // The first chunk is written, then the loop waits for drain.
        await vi.waitFor(() => expect(writeCount).toBe(1));
        // The client vanishes mid-stream: 'close' fires, 'drain' never does.
        emitClose();

        // The handler promise must resolve — racing the abort signal against
        // the drain wait releases the loop instead of parking forever.
        await expect(
            Promise.race([served, new Promise((_, reject) => setTimeout(() => reject(new Error('parked')), 500))])
        ).resolves.toBeUndefined();
    });

    it('does not park on backpressure when the response was already destroyed before the adapter listened', async () => {
        // 'close' fired during async middleware BEFORE toNodeHandler registered
        // its listener — `res.destroyed` is the entry-time witness. The
        // adapter must seed the abort from it so the drain wait cannot park.
        const { factory } = testFactory();
        const node = toNodeHandler(createMcpHandler(factory));

        const res: NodeServerResponseLike & { statusCode: number } = {
            statusCode: 0,
            destroyed: true,
            writeHead(statusCode: number) {
                this.statusCode = statusCode;
                return this;
            },
            write() {
                // Always report a full buffer; 'drain' will never fire and
                // 'close' already happened (no listener will ever be called).
                return false;
            },
            end() {
                return this;
            },
            on() {
                return this;
            }
        };

        const { req } = nodeRequestResponse(modernToolsCall('progress-then-echo', { text: 'gone' }));
        const served = node(req, res);

        // The handler promise must resolve — the entry-time `destroyed` check
        // seeds the abort signal so the drain race releases immediately.
        await expect(
            Promise.race([served, new Promise((_, reject) => setTimeout(() => reject(new Error('parked')), 500))])
        ).resolves.toBeUndefined();
    });

    it('answers with a 500 JSON-RPC error when handler.fetch throws (closed handler)', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);
        await handler.close();
        const node = toNodeHandler(handler);

        const parsed = modernToolsCall('echo', { text: 'late' });
        const { req, res, body } = nodeRequestResponse(undefined);
        Object.assign(req.headers, bodyDerivedStandardHeaders(parsed));
        await node(req, res, parsed);
        expect(res.statusCode).toBe(500);
        const payload = JSON.parse(await body()) as { error: { code: number }; id: unknown };
        expect(payload.error.code).toBe(-32_603);
        expect(payload.id).toBe(1);
    });

    it('reports the adapter-level fallback error to onerror before answering 500', async () => {
        const thrown = new Error('fetch boom');
        const onerror = vi.fn();
        const node = toNodeHandler(
            {
                fetch: () => {
                    throw thrown;
                }
            },
            { onerror }
        );

        const parsed = modernToolsCall('echo', { text: 'late' });
        const { req, res, body } = nodeRequestResponse(undefined);
        Object.assign(req.headers, bodyDerivedStandardHeaders(parsed));
        await node(req, res, parsed);

        expect(onerror).toHaveBeenCalledTimes(1);
        expect(onerror).toHaveBeenCalledWith(thrown);
        expect(res.statusCode).toBe(500);
        const payload = JSON.parse(await body()) as { error: { code: number }; id: unknown };
        expect(payload.error.code).toBe(-32_603);
        expect(payload.id).toBe(1);
    });

    it('still answers 500 when the onerror callback itself throws', async () => {
        const node = toNodeHandler(
            {
                fetch: () => {
                    throw new Error('fetch boom');
                }
            },
            {
                onerror: () => {
                    throw new Error('reporter boom');
                }
            }
        );

        const parsed = modernToolsCall('echo', { text: 'late' });
        const { req, res, body } = nodeRequestResponse(undefined);
        Object.assign(req.headers, bodyDerivedStandardHeaders(parsed));
        await node(req, res, parsed);

        expect(res.statusCode).toBe(500);
        const payload = JSON.parse(await body()) as { error: { code: number }; id: unknown };
        expect(payload.error.code).toBe(-32_603);
        expect(payload.id).toBe(1);
    });
});

/* ------------------------------------------------------------------------ *
 * Node face fixtures (duck-typed, no real sockets)
 * ------------------------------------------------------------------------ */

interface FakeNodeResponse extends NodeServerResponseLike {
    statusCode: number;
    headers: Record<string, string> | undefined;
}

function nodeRequestResponse(body: unknown): {
    req: Readable & {
        method: string;
        url: string;
        headers: Record<string, string>;
        auth?: { token: string; clientId: string; scopes: string[] };
    };
    res: FakeNodeResponse;
    body: () => Promise<string>;
} {
    const payload = body === undefined ? [] : [JSON.stringify(body)];
    const req = Object.assign(Readable.from(payload), {
        method: 'POST',
        url: '/mcp',
        headers: {
            host: 'localhost:3000',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...bodyDerivedStandardHeaders(body)
        } as Record<string, string>
    });

    const chunks: string[] = [];
    let resolveFinished: () => void;
    const finished = new Promise<void>(resolve => {
        resolveFinished = resolve;
    });
    const res: FakeNodeResponse = {
        statusCode: 0,
        headers: undefined,
        writeHead(statusCode: number, headers?: Record<string, string>) {
            this.statusCode = statusCode;
            this.headers = headers;
            return this;
        },
        write(chunk: string | Uint8Array) {
            chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
            return true;
        },
        end(chunk?: string | Uint8Array) {
            if (chunk !== undefined) {
                this.write(chunk);
            }
            resolveFinished();
            return this;
        },
        on() {
            return this;
        }
    };

    return {
        req,
        res,
        body: async () => {
            await finished;
            return chunks.join('');
        }
    };
}
