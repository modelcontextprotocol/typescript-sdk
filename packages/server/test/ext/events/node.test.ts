import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { Writable } from 'node:stream';

import type { MockInstance } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeWebhookSender } from '../../../src/ext/events/node';
import { isSpecialPurposeAddress } from '../../../src/ext/events/specialAddresses';
import type { WebhookSendRequest } from '../../../src/ext/events/types';

vi.mock('../../../src/ext/events/specialAddresses', async importOriginal => {
    const actual = await importOriginal<typeof import('../../../src/ext/events/specialAddresses')>();
    return { isSpecialPurposeAddress: vi.fn(actual.isSpecialPurposeAddress) };
});

const HEADERS = {
    'Content-Type': 'application/json',
    'webhook-id': 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W',
    'webhook-timestamp': '1763460000',
    'webhook-signature': 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=',
    'X-MCP-Subscription-Id': 'sub_1'
};
const BODY = JSON.stringify({ eventId: 'e1', name: 'e', timestamp: '2026-11-18T00:00:00.000Z', data: { n: 1 }, cursor: 'c1' });
const REFUSED = { error: 'connection_refused' };

const servers: net.Server[] = [];

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(isSpecialPurposeAddress).mockReset();
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>(resolve => {
                    if (server instanceof http.Server) server.closeAllConnections();
                    server.close(() => resolve());
                })
        )
    );
});

async function listen(server: net.Server): Promise<number> {
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

// A raw TCP server that counts connections and closes each one at once.
async function countingServer(): Promise<{ port: number; connections: () => number }> {
    let connections = 0;
    const port = await listen(
        net.createServer(socket => {
            connections += 1;
            socket.destroy();
        })
    );
    return { port, connections: () => connections };
}

function sendRequest(url: string, trusted: boolean, signal = new AbortController().signal): WebhookSendRequest {
    return { url, headers: HEADERS, body: BODY, trusted, signal };
}

type Resolve = MockInstance<(hostname: string) => Promise<string[]>>;

function dnsError(code: string): Error {
    return Object.assign(new Error(`query ${code}`), { code });
}

// Each send's resolve4 and resolve6 answer with the next list's addresses of their family, ENODATA without any; past the lists both fail with ENOTFOUND.
function stubResolver(...answers: string[][]): { resolve4: Resolve; resolve6: Resolve } {
    const stub = (method: 'resolve4' | 'resolve6', family: number): Resolve => {
        const spy = vi.spyOn(dns.promises.Resolver.prototype, method) as unknown as Resolve;
        spy.mockRejectedValue(dnsError('ENOTFOUND'));
        for (const answer of answers) {
            const addresses = answer.filter(address => net.isIP(address) === family);
            if (addresses.length === 0) spy.mockRejectedValueOnce(dnsError('ENODATA'));
            else spy.mockResolvedValueOnce(addresses);
        }
        return spy;
    };
    return { resolve4: stub('resolve4', 4), resolve6: stub('resolve6', 6) };
}

// Stands in for https.request: records the address its pinned lookup gives, and fails the connection.
function captureConnection(): { pinned: () => Promise<{ address: string; family: number }> } {
    let lookup: net.LookupFunction | undefined;
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, options: https.RequestOptions) => {
        lookup = options.lookup as net.LookupFunction;
        return failingRequest('ECONNREFUSED');
    }) as unknown as typeof https.request);
    return {
        pinned: () =>
            new Promise((resolve, reject) =>
                lookup!('pinned.invalid', {}, (error, address, family) =>
                    error ? reject(error) : resolve({ address: address as string, family: family! })
                )
            )
    };
}

// Classifies `ip` as a public address, so a loopback server can stand in for a remote receiver.
async function treatAsPublic(ip: string): Promise<void> {
    const actual = await vi.importActual<typeof import('../../../src/ext/events/specialAddresses')>(
        '../../../src/ext/events/specialAddresses'
    );
    vi.mocked(isSpecialPurposeAddress).mockImplementation(address => address !== ip && actual.isSpecialPurposeAddress(address));
}

// A stand-in for the outgoing request that fails with `code` once its body is sent.
function failingRequest(code: string): http.ClientRequest {
    const outgoing = new Writable({
        write: (_chunk, _encoding, callback) => callback(),
        final: callback => callback(Object.assign(new Error(code), { code }))
    });
    return outgoing as unknown as http.ClientRequest;
}

describe('nodeWebhookSender', () => {
    it('posts to a trusted http origin with the given headers and body', async () => {
        let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
        const port = await listen(
            http.createServer((req, res) => {
                let body = '';
                req.setEncoding('utf8');
                req.on('data', (chunk: string) => (body += chunk));
                req.on('end', () => {
                    seen = { method: req.method, url: req.url, headers: req.headers, body };
                    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
                });
            })
        );

        const outcome = await nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/hooks/mcp?tenant=1`, true));

        expect(outcome).toEqual({ status: 200, body: '{"ok":true}' });
        expect(seen).toMatchObject({
            method: 'POST',
            url: '/hooks/mcp?tenant=1',
            body: BODY,
            headers: {
                ...Object.fromEntries(Object.entries(HEADERS).map(([name, value]) => [name.toLowerCase(), value])),
                host: `127.0.0.1:${port}`
            }
        });
    });

    it('refuses an untrusted loopback url without connecting', async () => {
        const receiver = await countingServer();

        expect(await nodeWebhookSender()(sendRequest(`https://127.0.0.1:${receiver.port}/x`, false))).toEqual(REFUSED);
        expect(receiver.connections()).toBe(0);
    });

    it('checks an IP literal host without resolving it', async () => {
        const { resolve4, resolve6 } = stubResolver();
        const connection = captureConnection();

        expect(await nodeWebhookSender()(sendRequest('https://[::1]:8443/x', false))).toEqual(REFUSED);
        expect(isSpecialPurposeAddress).toHaveBeenCalledWith('::1');
        expect(https.request).not.toHaveBeenCalled();
        expect(await nodeWebhookSender()(sendRequest('https://1.1.1.1:8443/x', false))).toEqual(REFUSED);
        expect(await connection.pinned()).toEqual({ address: '1.1.1.1', family: 4 });
        expect(resolve4).not.toHaveBeenCalled();
        expect(resolve6).not.toHaveBeenCalled();
    });

    it('refuses http for an untrusted origin', async () => {
        const { resolve4 } = stubResolver();

        expect(await nodeWebhookSender()(sendRequest('http://example.com/hooks', false))).toEqual(REFUSED);
        expect(resolve4).not.toHaveBeenCalled();
    });

    it('refuses when any resolved address, of either family, is special, without connecting', async () => {
        const receiver = await countingServer();
        await treatAsPublic('127.0.0.1');
        stubResolver(['127.0.0.1', '10.0.0.1'], ['127.0.0.1', 'fe80::1'], ['2606:4700:4700::1111']);
        const send = nodeWebhookSender();

        expect(await send(sendRequest(`https://hooks.example.test:${receiver.port}/x`, false))).toEqual(REFUSED);
        expect(await send(sendRequest(`https://hooks.example.test:${receiver.port}/x`, false))).toEqual(REFUSED);
        expect(receiver.connections()).toBe(0);
        const connection = captureConnection();
        expect(await send(sendRequest('https://hooks.example.test/x', false))).toEqual(REFUSED);
        expect(await connection.pinned()).toEqual({ address: '2606:4700:4700::1111', family: 6 });
    });

    it('uses an AAAA answer for a host without A records, and fails when neither family resolves', async () => {
        const { resolve4, resolve6 } = stubResolver(['2606:4700:4700::1111']);
        const connection = captureConnection();
        const send = nodeWebhookSender();

        expect(await send(sendRequest('https://v6only.example.test/x', false))).toEqual(REFUSED);
        expect(await connection.pinned()).toEqual({ address: '2606:4700:4700::1111', family: 6 });
        expect(resolve4).toHaveBeenCalledWith('v6only.example.test');
        expect(resolve6).toHaveBeenCalledWith('v6only.example.test');
        vi.mocked(https.request).mockClear();
        expect(await send(sendRequest('https://nowhere.example.test/x', false))).toEqual(REFUSED);
        expect(https.request).not.toHaveBeenCalled();
    });

    it('cancels resolution at the 5 s deadline and reports a timeout', async () => {
        vi.useFakeTimers();
        const pending: Array<(error: Error) => void> = [];
        const hang = () => new Promise<string[]>((_resolve, reject) => pending.push(reject));
        vi.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockImplementation(hang);
        vi.spyOn(dns.promises.Resolver.prototype, 'resolve6').mockImplementation(hang);
        const cancel = vi.spyOn(dns.promises.Resolver.prototype, 'cancel').mockImplementation(() => {
            for (const reject of pending.splice(0)) reject(dnsError('ECANCELLED'));
        });

        const outcome = nodeWebhookSender()(sendRequest('https://silent.example.test/x', false));
        await vi.advanceTimersByTimeAsync(4999);
        expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toEqual({ error: 'timeout' });
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('connects to the checked address and sends the URL host name as TLS SNI', async () => {
        let clientHello: Buffer | undefined;
        const port = await listen(
            net.createServer(socket =>
                socket.once('data', (chunk: Buffer) => {
                    clientHello = chunk;
                    socket.destroy();
                })
            )
        );
        await treatAsPublic('127.0.0.1');
        const { resolve4 } = stubResolver(['127.0.0.1']);

        // The receiver resets the connection after reading the ClientHello.
        expect(await nodeWebhookSender()(sendRequest(`https://hooks.example.test:${port}/x`, false))).toEqual(REFUSED);
        expect(resolve4).toHaveBeenCalledWith('hooks.example.test');
        expect(clientHello?.includes('hooks.example.test')).toBe(true);
    });

    it('checks the resolved address at every send', async () => {
        const receiver = await countingServer();
        await treatAsPublic('127.0.0.1');
        stubResolver(['127.0.0.1'], ['10.0.0.1']);
        const send = nodeWebhookSender();

        await send(sendRequest(`https://hooks.example.test:${receiver.port}/x`, false));
        expect(receiver.connections()).toBe(1);
        expect(await send(sendRequest(`https://hooks.example.test:${receiver.port}/x`, false))).toEqual(REFUSED);
        expect(receiver.connections()).toBe(1);
    });

    it('does not follow redirects', async () => {
        let followed = 0;
        const other = await listen(
            http.createServer((_req, res) => {
                followed += 1;
                res.end();
            })
        );
        const port = await listen(
            http.createServer((req, res) => {
                req.resume();
                res.writeHead(302, { Location: `http://127.0.0.1:${other}/next` }).end();
            })
        );

        expect(await nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/x`, true))).toEqual({ status: 302, body: '' });
        expect(followed).toBe(0);
    });

    it('times out a hanging receiver after 5 s', async () => {
        const port = await listen(http.createServer(() => {}));
        const started = Date.now();

        expect(await nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/x`, true))).toEqual({ error: 'timeout' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    }, 10_000);

    it('reads at most 65 536 bytes of the response body', async () => {
        const port = await listen(
            http.createServer((req, res) => {
                req.resume();
                res.end('a'.repeat(100_000));
            })
        );

        expect(await nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/x`, true))).toEqual({
            status: 200,
            body: 'a'.repeat(65_536)
        });
    });

    it('reports a receiver that does not speak TLS as tls_error', async () => {
        const port = await listen(http.createServer((_req, res) => res.end()));

        expect(await nodeWebhookSender()(sendRequest(`https://127.0.0.1:${port}/x`, true))).toEqual({ error: 'tls_error' });
    });

    it.each([
        ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_error'],
        ['INVALID_CA', 'tls_error'],
        ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_error'],
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_error'],
        ['CERT_HAS_EXPIRED', 'tls_error'],
        ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls_error'],
        ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls_error'],
        ['EPROTO', 'tls_error'],
        ['ECONNREFUSED', 'connection_refused'],
        ['ECONNRESET', 'connection_refused'],
        ['EHOSTUNREACH', 'connection_refused'],
        ['ENOTFOUND', 'connection_refused']
    ])('maps a request that fails with %s to %s', async (code, category) => {
        vi.spyOn(https, 'request').mockImplementation(() => failingRequest(code));

        expect(await nodeWebhookSender()(sendRequest('https://127.0.0.1:8443/x', true))).toEqual({ error: category });
    });

    it('reports a closed port as connection_refused', async () => {
        const server = net.createServer();
        const port = await listen(server);
        await new Promise<void>(resolve => server.close(() => resolve()));

        expect(await nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/x`, true))).toEqual(REFUSED);
    });

    it('resolves rather than rejects when its signal aborts', async () => {
        let received!: () => void;
        const arrived = new Promise<void>(resolve => (received = resolve));
        const port = await listen(http.createServer(() => received()));
        const controller = new AbortController();

        const outcome = nodeWebhookSender()(sendRequest(`http://127.0.0.1:${port}/x`, true, controller.signal));
        await arrived;
        controller.abort();

        expect(await outcome).toEqual(REFUSED);
    });
});
