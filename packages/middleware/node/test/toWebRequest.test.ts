/**
 * `toWebRequest(req, parsedBody?, options?)` — the exported Node
 * `IncomingMessage` → web-standard `Request` conversion. Covers the two body
 * paths (the Node stream read vs. a supplied `parsedBody` re-serialized, with
 * the entity headers rewritten and the stream untouched), Host-header URL
 * derivation, header copying (multi-valued append, HTTP/2 pseudo-header
 * skipping), the GET/HEAD no-body rule, the `signal` option, and the
 * clone-readability contract `isLegacyRequest(request)` relies on. The full
 * adapter exercises the same conversion end-to-end in `toNodeHandler.test.ts`.
 */
import { Readable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import type { NodeIncomingMessageLike } from '../src/toNodeHandler';
import { toWebRequest } from '../src/toNodeHandler';

function nodeRequest(init: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
    body?: string;
}): NodeIncomingMessageLike {
    return Object.assign(Readable.from(init.body === undefined ? [] : [init.body]), {
        method: init.method,
        url: init.url,
        headers: init.headers ?? {}
    });
}

/** A request whose Node stream rejects if anything iterates it. */
function unreadableNodeRequest(init: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
}): NodeIncomingMessageLike {
    return {
        method: init.method,
        url: init.url,
        headers: init.headers ?? {},
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
            return { next: () => Promise.reject(new Error('the Node stream must not be read when parsedBody is supplied')) };
        }
    };
}

describe('toWebRequest', () => {
    it('reads the Node stream as the body when no parsedBody is supplied', async () => {
        const raw = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
        const request = await toWebRequest(
            nodeRequest({
                method: 'post',
                url: '/mcp',
                headers: { host: 'localhost:3000', 'content-type': 'application/json' },
                body: raw
            })
        );

        expect(request.method).toBe('POST');
        expect(request.url).toBe('http://localhost:3000/mcp');
        expect(request.headers.get('content-type')).toBe('application/json');
        expect(await request.text()).toBe(raw);
    });

    it('re-serializes a supplied parsedBody, rewrites the entity headers, and never touches the Node stream', async () => {
        // A non-ASCII character keeps the byte length and the string length
        // apart, so the rewritten content-length is provably the byte count.
        const parsed = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'écho' } };
        const request = await toWebRequest(
            unreadableNodeRequest({
                method: 'POST',
                url: '/mcp',
                headers: {
                    host: 'example.test:4321',
                    'content-type': 'application/json',
                    'content-length': '999',
                    'content-encoding': 'gzip',
                    'transfer-encoding': 'chunked',
                    accept: ['application/json', 'text/event-stream']
                }
            }),
            parsed
        );

        expect(request.method).toBe('POST');
        expect(request.url).toBe('http://example.test:4321/mcp');
        expect(request.headers.get('content-type')).toBe('application/json');
        // Multi-valued Node headers are appended, not collapsed to the first value.
        expect(request.headers.get('accept')).toBe('application/json, text/event-stream');
        // The entity headers described the original raw bytes; they are gone or rewritten.
        expect(request.headers.get('content-encoding')).toBeNull();
        expect(request.headers.get('transfer-encoding')).toBeNull();
        const text = await request.text();
        expect(text).toBe(JSON.stringify(parsed));
        expect(request.headers.get('content-length')).toBe(String(text.length + 1));
    });

    it('hands the body on so that it reads back identically as text and as JSON, from the Node stream and from a parsedBody', async () => {
        const parsed = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'écho', arguments: { text: 'naïve ☃' } } };
        // Whitespace padding, and a multi-byte character split across two chunks.
        const raw = Buffer.from(`${JSON.stringify(parsed)}${' '.repeat(1000)}`);
        const split = raw.indexOf(Buffer.from('é')) + 1;
        const streamed = await toWebRequest(
            Object.assign(Readable.from([raw.subarray(0, split), raw.subarray(split)]), {
                method: 'POST',
                url: '/mcp',
                headers: { host: 'localhost', 'content-type': 'application/json' }
            })
        );
        const preParsed = await toWebRequest(
            unreadableNodeRequest({ method: 'POST', url: '/mcp', headers: { host: 'localhost', 'content-type': 'application/json' } }),
            parsed
        );

        expect(await streamed.clone().json()).toEqual(parsed);
        expect(await streamed.text()).toBe(raw.toString('utf8'));
        expect(await preParsed.clone().json()).toEqual(parsed);
        expect(await preParsed.text()).toBe(JSON.stringify(parsed));
    });

    it('keeps none of the body once a converted Request has been read and dropped', async () => {
        setFlagsFromString('--expose-gc');
        const gc = runInNewContext('gc') as () => void;
        // `ArrayBuffer` memory after collecting garbage, each pass in a fresh task.
        const arrayBuffers = async (): Promise<number> => {
            for (let pass = 0; pass < 3; pass++) {
                await new Promise(resolve => setTimeout(resolve, 0));
                gc();
            }
            return process.memoryUsage().arrayBuffers;
        };
        const chunk = Buffer.alloc(10_240, 0x20);
        const before = await arrayBuffers();

        for (let count = 0; count < 2000; count++) {
            const request = await toWebRequest(
                Object.assign(Readable.from([chunk]), { method: 'POST', url: '/mcp', headers: { host: 'localhost' } })
            );
            await request.text();
        }

        // 2 000 bodies of 10 KiB kept would be about 20 MiB.
        expect((await arrayBuffers()) - before).toBeLessThan(4 * 1024 * 1024);
    });

    it('produces a body-less Request when the supplied parsedBody is not JSON-serializable', async () => {
        const request = await toWebRequest(
            unreadableNodeRequest({ method: 'POST', url: '/mcp', headers: { host: 'localhost', 'content-length': '42' } }),
            // JSON.stringify(() => {}) is undefined: there are no bytes to describe.
            () => {}
        );
        expect(request.body).toBeNull();
        expect(request.headers.get('content-length')).toBeNull();
    });

    it('derives the URL host from the Host header (falling back to localhost)', async () => {
        const withHost = await toWebRequest(nodeRequest({ method: 'GET', url: '/a?b=1', headers: { host: 'api.example.test' } }));
        expect(new URL(withHost.url).host).toBe('api.example.test');
        expect(new URL(withHost.url).pathname).toBe('/a');
        expect(new URL(withHost.url).search).toBe('?b=1');

        const withoutHost = await toWebRequest(nodeRequest({ method: 'GET', url: '/a' }));
        expect(new URL(withoutHost.url).host).toBe('localhost');
    });

    it('derives the URL host from :authority for an HTTP/2 request (no host header) and drops pseudo-headers', async () => {
        // A real HTTP/2 client sends only the pseudo-header — no `host` entry.
        const request = await toWebRequest(
            nodeRequest({
                method: 'GET',
                url: '/mcp',
                headers: { ':authority': 'h2.example.test:8443', ':path': '/mcp', ':scheme': 'http', 'mcp-protocol-version': '2026-07-28' }
            })
        );
        expect(new URL(request.url).host).toBe('h2.example.test:8443');
        // Pseudo-header names are skipped — `Headers` rejects them.
        expect(request.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    });

    it('prefers the host header over :authority when both are present', async () => {
        const request = await toWebRequest(
            nodeRequest({ method: 'GET', url: '/mcp', headers: { host: 'h1.example.test', ':authority': 'h2.example.test' } })
        );
        expect(new URL(request.url).host).toBe('h1.example.test');
    });

    it('produces a body-less Request for GET/HEAD even when parsedBody is supplied', async () => {
        const request = await toWebRequest(nodeRequest({ method: 'GET', url: '/mcp', headers: { host: 'localhost' } }), {
            ignored: true
        });
        expect(request.method).toBe('GET');
        expect(request.body).toBeNull();
    });

    it('attaches options.signal to the constructed Request', async () => {
        const controller = new AbortController();
        const request = await toWebRequest(nodeRequest({ method: 'GET', url: '/mcp', headers: { host: 'localhost' } }), undefined, {
            signal: controller.signal
        });
        expect(request.signal.aborted).toBe(false);
        controller.abort();
        expect(request.signal.aborted).toBe(true);
    });

    it('returns a Request whose body a clone-reader leaves readable (the isLegacyRequest contract)', async () => {
        const raw = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
        const request = await toWebRequest(
            nodeRequest({ method: 'POST', url: '/mcp', headers: { host: 'localhost', 'content-type': 'application/json' }, body: raw })
        );
        // `isLegacyRequest(request)` classifies a clone; the caller's request
        // must stay readable for whichever handler it routes to.
        expect(await request.clone().text()).toBe(raw);
        expect(await request.text()).toBe(raw);
    });
});
