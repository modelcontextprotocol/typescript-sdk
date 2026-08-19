import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider, AuthRequestContext } from '../../src/client/auth';
import { SSEClientTransport } from '../../src/client/sse';

/** Same shape as the StreamableHTTP DPoP test's fake — see streamableHttp.dpop.test.ts. */
function createDpopAuthProvider(): AuthProvider & { authorizeRequest: Mock; consumeChallenge: Mock; onUnauthorized: Mock } {
    return {
        token: vi.fn().mockResolvedValue(undefined),
        authorizeRequest: vi.fn(async (ctx: AuthRequestContext) => ({
            Authorization: 'DPoP the-access-token',
            DPoP: `proof-for-${ctx.method}-${ctx.url.pathname}`
        })),
        consumeChallenge: vi.fn().mockResolvedValue(false),
        onUnauthorized: vi.fn().mockResolvedValue(undefined)
    };
}

describe('SSEClientTransport — DPoP', () => {
    let resourceServer: Server;
    let resourceBaseUrl: URL;
    let transport: SSEClientTransport;
    let authProvider: ReturnType<typeof createDpopAuthProvider>;
    let postHandler: (req: IncomingMessage, res: ServerResponse) => void;

    beforeEach(async () => {
        authProvider = createDpopAuthProvider();
        postHandler = (_req, res) => res.writeHead(200).end();

        // The announced message endpoint is deliberately a different path from the SSE URL (the
        // normal shape for this transport) so the POST proof's htu binding is actually exercised.
        resourceServer = createServer((req, res) => {
            if (req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive'
                });
                res.write('event: endpoint\n');
                res.write(`data: ${resourceBaseUrl.origin}/messages?sessionId=s1\n\n`);
                return;
            }
            let body = '';
            req.on('data', chunk => (body += chunk));
            req.on('end', () => postHandler(req, res));
        });

        await new Promise<void>(resolve => {
            resourceServer.listen(0, '127.0.0.1', () => {
                const addr = resourceServer.address() as AddressInfo;
                resourceBaseUrl = new URL(`http://127.0.0.1:${addr.port}`);
                resolve();
            });
        });

        transport = new SSEClientTransport(resourceBaseUrl, { authProvider });
        await transport.start();
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        await new Promise<void>(resolve => resourceServer.close(() => resolve()));
        vi.clearAllMocks();
    });

    it('presents DPoP Authorization + a per-request proof on the GET SSE stream', () => {
        // authorizeRequest is called by _startOrAuth (invoked by transport.start() in beforeEach).
        expect(authProvider.authorizeRequest).toHaveBeenCalledWith({ method: 'GET', url: resourceBaseUrl });
    });

    it('presents DPoP Authorization + a per-request proof on POST, bound to the message endpoint (not the SSE URL)', async () => {
        let receivedAuth: string | undefined;
        let receivedProof: string | undefined;
        postHandler = (req, res) => {
            receivedAuth = req.headers.authorization;
            receivedProof = req.headers.dpop as string | undefined;
            res.writeHead(200).end();
        };

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(receivedAuth).toBe('DPoP the-access-token');
        // RFC 9449 §4.2: htu is the URI of *this* request — the announced /messages endpoint.
        expect(authProvider.authorizeRequest).toHaveBeenCalledWith({
            method: 'POST',
            url: new URL(`${resourceBaseUrl.origin}/messages?sessionId=s1`)
        });
        expect(receivedProof).toBe('proof-for-POST-/messages');
    });

    it('retries once on a use_dpop_nonce challenge from the POST endpoint', async () => {
        let postCalls = 0;
        authProvider.consumeChallenge.mockImplementation(async (res: Response) => res.status === 401 && res.headers.has('dpop-nonce'));
        postHandler = (_req, res) => {
            postCalls++;
            if (postCalls === 1) {
                res.writeHead(401, { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }).end();
                return;
            }
            res.writeHead(200).end();
        };

        await transport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(postCalls).toBe(2);
        expect(authProvider.consumeChallenge).toHaveBeenCalledTimes(1);
        // The nonce is remembered per origin of ctx.url, so it must be the endpoint actually POSTed to.
        expect(authProvider.consumeChallenge.mock.calls[0]![1]).toEqual({
            method: 'POST',
            url: new URL(`${resourceBaseUrl.origin}/messages?sessionId=s1`)
        });
        expect(authProvider.onUnauthorized).not.toHaveBeenCalled();
    });

    it('falls back to Bearer + token() when the provider has no authorizeRequest (back-compat)', async () => {
        await transport.close();
        const bearerProvider: AuthProvider = { token: vi.fn().mockResolvedValue('bearer-tok') };
        const bearerTransport = new SSEClientTransport(resourceBaseUrl, { authProvider: bearerProvider });
        await bearerTransport.start();

        let receivedAuth: string | undefined;
        postHandler = (req, res) => {
            receivedAuth = req.headers.authorization;
            res.writeHead(200).end();
        };
        await bearerTransport.send({ jsonrpc: '2.0', method: 'test', params: {}, id: 'id-1' });

        expect(receivedAuth).toBe('Bearer bearer-tok');
        await bearerTransport.close();
    });
});
