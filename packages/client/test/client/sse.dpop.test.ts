import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FetchLike } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider, OAuthClientProvider } from '../../src/client/auth';
import { DpopSession } from '../../src/client/dpop';
import { SSEClientTransport } from '../../src/client/sse';

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

interface Seen {
    method: string;
    path: string;
    authorization?: string;
    proof?: Record<string, unknown>;
}

/**
 * Drives the transport against a real HTTP+SSE server with a real {@linkcode DpopSession} behind an
 * {@linkcode OAuthClientProvider}, asserting on what the server receives. The announced message
 * endpoint is deliberately a different path from the SSE URL (the normal shape for this transport)
 * so the POST proof's `htu` binding is actually exercised.
 */
describe('SSEClientTransport — DPoP', () => {
    let server: Server;
    let baseUrl: URL;
    let session: DpopSession;
    let provider: OAuthClientProvider;
    let transport: SSEClientTransport;
    let seen: Seen[];
    let postHandler: (req: IncomingMessage, res: ServerResponse) => void;

    beforeEach(async () => {
        seen = [];
        postHandler = (_req, res) => res.writeHead(202).end();
        server = createServer((req, res) => {
            const proofHeader = req.headers.dpop as string | undefined;
            seen.push({
                method: req.method!,
                path: req.url!.split('?')[0]!,
                authorization: req.headers.authorization,
                proof: proofHeader ? decodeJwtPart(proofHeader.split('.')[1]!) : undefined
            });
            if (req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive'
                });
                res.write('event: endpoint\n');
                res.write(`data: ${baseUrl.origin}/messages?sessionId=s1\n\n`);
                return;
            }
            req.resume().on('end', () => postHandler(req, res));
        });
        await new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                baseUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`);
                resolve();
            });
        });

        session = await DpopSession.create();
        provider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn(),
            tokens: vi.fn().mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' }),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            dpop: () => session
        };
        transport = new SSEClientTransport(baseUrl, { authProvider: provider });
        await transport.start();
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('presents DPoP Authorization + a proof bound to GET and the SSE URL on the event stream', () => {
        expect(seen[0]).toMatchObject({ method: 'GET', authorization: 'DPoP tok-1', proof: { htm: 'GET', htu: baseUrl.href } });
    });

    it('presents DPoP Authorization + a proof on POST, bound to the announced message endpoint (not the SSE URL)', async () => {
        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        // RFC 9449 §4.2: htu is the URI of *this* request, minus query — the /messages endpoint.
        expect(seen[1]).toMatchObject({
            method: 'POST',
            path: '/messages',
            authorization: 'DPoP tok-1',
            proof: { htm: 'POST', htu: `${baseUrl.origin}/messages` }
        });
    });

    it('retries the POST once on a use_dpop_nonce challenge, with a fresh proof carrying the nonce, without re-authorizing', async () => {
        const onUnauthorized = vi.spyOn((transport as unknown as { _authProvider: AuthProvider })._authProvider, 'onUnauthorized');
        let postCalls = 0;
        postHandler = (_req, res) => {
            postCalls++;
            if (postCalls === 1) {
                res.writeHead(401, { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }).end();
                return;
            }
            res.writeHead(202).end();
        };

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        const posts = seen.filter(s => s.method === 'POST');
        expect(posts).toHaveLength(2);
        expect(posts[1]!.proof).toMatchObject({ htu: `${baseUrl.origin}/messages`, nonce: 'rs-nonce-1' });
        expect(posts[1]!.proof!.jti).not.toBe(posts[0]!.proof!.jti);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('wraps a caller-supplied eventSourceInit.fetch too (it still runs, and the stream request is DPoP-signed)', async () => {
        await transport.close();
        const esFetch = vi.fn<FetchLike>((url, init) => fetch(url, init));
        const t = new SSEClientTransport(baseUrl, { authProvider: provider, eventSourceInit: { fetch: esFetch as typeof fetch } });

        await t.start();

        expect(esFetch).toHaveBeenCalledTimes(1);
        expect(new Headers(esFetch.mock.calls[0]![1]!.headers).get('Authorization')).toBe('DPoP tok-1');
        expect(seen.at(-1)).toMatchObject({ method: 'GET', proof: { htm: 'GET' } });
        await t.close();
    });

    it('leaves a plain AuthProvider untouched (Bearer via token())', async () => {
        await transport.close();
        const bearer = new SSEClientTransport(baseUrl, { authProvider: { token: async () => 'bearer-tok' } });
        await bearer.start();

        await bearer.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(seen.at(-1)).toMatchObject({ method: 'POST', authorization: 'Bearer bearer-tok', proof: undefined });
        await bearer.close();
    });
});
