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

    it('skips HTTP/2 pseudo-headers, whose names Headers rejects', async () => {
        const request = await toWebRequest(
            nodeRequest({
                method: 'GET',
                url: '/mcp',
                headers: { host: 'h2.example.test', ':authority': 'h2.example.test', ':path': '/mcp', 'mcp-protocol-version': '2026-07-28' }
            })
        );
        expect(new URL(request.url).host).toBe('h2.example.test');
        expect(request.headers.get('mcp-protocol-version')).toBe('2026-07-28');
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
