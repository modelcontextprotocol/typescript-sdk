import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
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

async function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, host, resolve));
    return (server.address() as AddressInfo).port;
}

// A raw TCP server that counts connections and closes each one at once.
async function countingServer(host?: string): Promise<{ port: number; connections: () => number }> {
    let connections = 0;
    const port = await listen(
        net.createServer(socket => {
            connections += 1;
            socket.destroy();
        }),
        host
    );
    return { port, connections: () => connections };
}

const hasIpv6Loopback = Object.values(os.networkInterfaces()).some(entries => entries?.some(entry => entry.address === '::1'));

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

type Answer = { address: string; family: number } | dns.LookupAddress[];

// Stands in for https.request: keeps the pinned lookup, which `lookup` calls with the options Node would pass, and fails the connection.
function captureConnection(): { pinned: () => Promise<Answer>; lookup: (options: dns.LookupOptions) => Promise<Answer> } {
    let pinned: net.LookupFunction | undefined;
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, options: https.RequestOptions) => {
        pinned = options.lookup as net.LookupFunction;
        return failingRequest('ECONNREFUSED');
    }) as unknown as typeof https.request);
    const lookup = (options: dns.LookupOptions): Promise<Answer> =>
        new Promise((resolve, reject) =>
            pinned!('pinned.invalid', options, (error, address, family) => {
                if (error) reject(error);
                else resolve(Array.isArray(address) ? address : { address, family: family! });
            })
        );
    return { pinned: () => lookup({}), lookup };
}

// Classifies `ips` as public addresses, so a loopback server can stand in for a remote receiver.
async function treatAsPublic(...ips: string[]): Promise<void> {
    const actual = await vi.importActual<typeof import('../../../src/ext/events/specialAddresses')>(
        '../../../src/ext/events/specialAddresses'
    );
    vi.mocked(isSpecialPurposeAddress).mockImplementation(address => !ips.includes(address) && actual.isSpecialPurposeAddress(address));
}

// A resolver whose `family` query answers at once with `addresses` and whose other query waits for cancel().
function halfAnsweringResolver(family: 4 | 6, addresses: string[]): void {
    const pending: Array<(error: Error) => void> = [];
    const [answering, hanging] = family === 4 ? (['resolve4', 'resolve6'] as const) : (['resolve6', 'resolve4'] as const);
    vi.spyOn(dns.promises.Resolver.prototype, answering).mockResolvedValue(addresses as never);
    vi.spyOn(dns.promises.Resolver.prototype, hanging).mockImplementation(
        () => new Promise((_resolve, reject) => pending.push(reject)) as never
    );
    vi.spyOn(dns.promises.Resolver.prototype, 'cancel').mockImplementation(() => {
        for (const reject of pending.splice(0)) reject(dnsError('ECANCELLED'));
    });
}

// Stands in for https.request with a request that never answers.
function hangingRequests(): void {
    vi.spyOn(https, 'request').mockImplementation(
        () => new Writable({ write: (_chunk, _encoding, callback) => callback() }) as unknown as http.ClientRequest
    );
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

    it('times out at the deadline without a request when one family answered and the other was still resolving', async () => {
        vi.useFakeTimers();
        halfAnsweringResolver(4, ['1.1.1.1']);
        hangingRequests();
        let settled: unknown;
        void nodeWebhookSender()(sendRequest('https://half.example.test/x', false)).then(outcome => (settled = outcome));

        await vi.advanceTimersByTimeAsync(4999);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toEqual({ error: 'timeout' });
        expect(https.request).not.toHaveBeenCalled();
    });

    it('sends nothing when its signal aborts while one family is still resolving', async () => {
        halfAnsweringResolver(6, ['2606:4700:4700::1111']);
        hangingRequests();
        const controller = new AbortController();

        const outcome = nodeWebhookSender()(sendRequest('https://half.example.test/x', false, controller.signal));
        await vi.waitFor(() => expect(dns.promises.Resolver.prototype.resolve6).toHaveBeenCalled());
        controller.abort();

        expect(await outcome).toEqual(REFUSED);
        expect(https.request).not.toHaveBeenCalled();
    });

    it('answers every checked address of both families when asked for all, and only those of the family asked for', async () => {
        stubResolver(['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111']);
        const connection = captureConnection();

        expect(await nodeWebhookSender()(sendRequest('https://dual.example.test/x', false))).toEqual(REFUSED);
        expect(await connection.lookup({ all: true })).toEqual([
            { address: '1.1.1.1', family: 4 },
            { address: '1.0.0.1', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 }
        ]);
        expect(await connection.lookup({ all: true, family: 6 })).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
        expect(await connection.lookup({ family: 6 })).toEqual({ address: '2606:4700:4700::1111', family: 6 });
        expect(await connection.lookup({ family: 'IPv4' })).toEqual({ address: '1.1.1.1', family: 4 });
        expect(await connection.lookup({})).toEqual({ address: '1.1.1.1', family: 4 });
    });

    describe('with ADDRCONFIG', () => {
        const entry = (family: 'IPv4' | 'IPv6', address: string, internal = false) =>
            ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
        const loopback = { lo0: [entry('IPv4', '127.0.0.1', true), entry('IPv6', '::1', true)] };
        const A = { address: '1.1.1.1', family: 4 };
        const AAAA = { address: '2606:4700:4700::1111', family: 6 };

        // The pinned lookup of a send to a host with one checked address of each family.
        async function dualStackLookup() {
            stubResolver(['1.1.1.1', '2606:4700:4700::1111']);
            const connection = captureConnection();
            await nodeWebhookSender()(sendRequest('https://dual.example.test/x', false));
            return (options: dns.LookupOptions = {}) => connection.lookup({ all: true, hints: dns.ADDRCONFIG, ...options });
        }

        it('answers only the families the host has an address of that is neither internal nor link-local, or all when none is', async () => {
            const interfaces = vi.spyOn(os, 'networkInterfaces');
            const lookup = await dualStackLookup();

            interfaces.mockReturnValue({ ...loopback, en0: [entry('IPv4', '192.168.1.2')] });
            expect(await lookup()).toEqual([A]);
            expect(await lookup({ hints: 0 })).toEqual([A, AAAA]);
            // Linux gives every interface an fe80:: address, routed or not.
            interfaces.mockReturnValue({ ...loopback, eth0: [entry('IPv4', '192.168.1.2'), entry('IPv6', 'fe80::1')] });
            expect(await lookup()).toEqual([A]);
            interfaces.mockReturnValue({ ...loopback, eth0: [entry('IPv4', '192.168.1.2'), entry('IPv6', '2001:db8::2')] });
            expect(await lookup()).toEqual([A, AAAA]);
            interfaces.mockReturnValue(loopback);
            expect(await lookup()).toEqual([A, AAAA]);
            interfaces.mockReturnValue({ ...loopback, eth0: [entry('IPv6', '2001:db8::2')] });
            expect(await lookup({ family: 4 })).toEqual([A]);
        });

        it('does not count an IPv4 link-local address', async () => {
            const interfaces = vi.spyOn(os, 'networkInterfaces');
            const lookup = await dualStackLookup();

            interfaces.mockReturnValue({ ...loopback, eth0: [entry('IPv4', '169.254.10.20'), entry('IPv6', '2001:db8::2')] });
            expect(await lookup()).toEqual([AAAA]);
            interfaces.mockReturnValue({ ...loopback, eth0: [entry('IPv4', '169.254.10.20'), entry('IPv6', 'fe80::1')] });
            expect(await lookup()).toEqual([A, AAAA]);
        });

        it('answers every checked address when the interfaces cannot be read', async () => {
            vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
                throw Object.assign(new Error('uv_interface_addresses returned Unknown system error 1'), { code: 'ERR_SYSTEM_ERROR' });
            });
            const lookup = await dualStackLookup();

            expect(await lookup()).toEqual([A, AAAA]);
            expect(await lookup({ all: false, family: 6 })).toEqual(AAAA);
        });
    });

    it('fails the lookup for a family with no checked address', async () => {
        stubResolver(['1.1.1.1']);
        const connection = captureConnection();

        await nodeWebhookSender()(sendRequest('https://v4only.example.test/x', false));
        await expect(connection.lookup({ all: true, family: 6 })).rejects.toMatchObject({ code: 'ENOTFOUND' });
        await expect(connection.lookup({ family: 6 })).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    it.skipIf(!hasIpv6Loopback)('connects to the AAAA address when the A address does not answer', async () => {
        // A dual-stack host, so ADDRCONFIG keeps both families.
        vi.spyOn(os, 'networkInterfaces').mockReturnValue({
            en0: [
                { address: '192.168.1.2', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
                { address: '2001:db8::2', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 }
            ]
        });
        const receiver = await countingServer('::1');
        await treatAsPublic('192.0.2.1', '::1');
        stubResolver(['192.0.2.1', '::1']);

        // 192.0.2.1 is TEST-NET-1, which nothing answers, so Node moves on to ::1; the receiver closes the connection it gets.
        expect(await nodeWebhookSender()(sendRequest(`https://dual.example.test:${receiver.port}/x`, false))).toEqual(REFUSED);
        expect(receiver.connections()).toBe(1);
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
