// @modelcontextprotocol/server/ext/events/node
//
// Node.js webhook sender for the MCP Events extension (SEP-3415). The only
// module of the events extension that imports Node built-ins.

import type { LookupAddress } from 'node:dns';
import dns from 'node:dns';
import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import net from 'node:net';
import os from 'node:os';

import { isSpecialPurposeAddress } from './specialAddresses';
import type { WebhookSender, WebhookSendOutcome, WebhookSendRequest } from './types';

const TIMEOUT_MS = 5000;
// The resolver's timeout per query and its tries per name server; the 5 s deadline cancels whatever resolution is left.
const RESOLVE_TIMEOUT_MS = 1000;
const RESOLVE_TRIES = 2;
const MAX_RESPONSE_BYTES = 65_536;
const REFUSED: WebhookSendOutcome = { error: 'connection_refused' };
// OpenSSL certificate and verification codes, Node's TLS and OpenSSL error codes, and EPROTO, which Node reports for a failed TLS handshake.
const TLS_FAILURE_CODE = /CERT|UNABLE_TO_VERIFY|INVALID_CA|SELF_SIGNED|DEPTH_ZERO|^ERR_SSL_|^ERR_TLS_|^EPROTO$/;
// IPv6 fe80::/10 and IPv4 169.254.0.0/16, which every interface can have without a route off its link.
const LINK_LOCAL = /^fe[89ab][\da-f]:|^169\.254\./i;

/**
 * The default {@linkcode WebhookSender} for Node.js, hardened against
 * server-side request forgery. Unless the URL's origin is in `trustedOrigins`,
 * it requires `https`, resolves the host's A and AAAA records at every send
 * (with a DNS query, not `getaddrinfo`, so `/etc/hosts` does not apply),
 * refuses with `connection_refused` when any resolved address is in an IANA
 * special-purpose range (loopback, private, link-local and the like), and
 * connects only to the addresses it checked, which Node tries in turn (only
 * those of a family the host has an interface address of that is neither
 * loopback nor link-local, unless that leaves none or the host's interfaces
 * cannot be read), with the URL's host name
 * in the `Host` header and TLS SNI. It follows no redirects (a 3xx answer is
 * returned as it is), gives up after 5 seconds with `{ error: 'timeout' }`,
 * and reads at most 64 KiB of the response body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export function nodeWebhookSender(): WebhookSender {
    return send;
}

async function send(request: WebhookSendRequest): Promise<WebhookSendOutcome> {
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
    // Only a trusted origin may use plain http.
    if (url === undefined || !(url.protocol === 'https:' || (request.trusted && url.protocol === 'http:'))) return REFUSED;
    if (request.signal.aborted) return REFUSED;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        deadline.abort();
    }, TIMEOUT_MS);
    const stop = (): void => deadline.abort();
    request.signal.addEventListener('abort', stop, { once: true });
    try {
        let lookup: LookupFunction | undefined;
        if (!request.trusted) {
            const addresses = await resolve(hostnameOf(url), deadline.signal);
            // An abort while one family was still resolving leaves the other family's addresses.
            deadline.signal.throwIfAborted();
            if (addresses.length === 0 || addresses.some(({ address }) => isSpecialPurposeAddress(address))) return REFUSED;
            lookup = pinnedTo(addresses);
        }
        return await post(url, request, lookup, deadline.signal);
    } catch (error) {
        return timedOut ? { error: 'timeout' } : failureOf(error);
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', stop);
    }
}

// One POST; it rejects on a connection or TLS failure, and once `signal` aborts (at once, without a request, when it already has).
function post(url: URL, request: WebhookSendRequest, lookup: LookupFunction | undefined, signal: AbortSignal): Promise<WebhookSendOutcome> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const onResponse = (response: IncomingMessage): void => {
            const chunks: Buffer[] = [];
            let size = 0;
            const answer = (): void =>
                resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8', 0, MAX_RESPONSE_BYTES) });
            response.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.byteLength;
                if (size < MAX_RESPONSE_BYTES) return;
                answer();
                outgoing.destroy();
            });
            response.on('end', answer);
            response.on('error', reject);
        };
        // A fresh agent per request, so no pooled socket or global agent setting bypasses the pinned address; Host and SNI come from the URL.
        const options: https.RequestOptions = { method: 'POST', headers: request.headers, agent: false, ...(lookup && { lookup }) };
        const outgoing = url.protocol === 'https:' ? https.request(url, options, onResponse) : http.request(url, options, onResponse);
        outgoing.on('error', reject);
        signal.addEventListener(
            'abort',
            () => {
                reject(signal.reason);
                outgoing.destroy();
            },
            { once: true }
        );
        outgoing.end(request.body);
    });
}

// The host's A and AAAA addresses, from a resolver of its own (c-ares, off libuv's thread pool) that `signal` cancels; an IP literal is its own address. Rejects when neither family resolves.
async function resolve(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
    const family = net.isIP(hostname);
    if (family !== 0) return [{ address: hostname, family }];
    const resolver = new dns.promises.Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: RESOLVE_TRIES });
    const cancel = (): void => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
        const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
        if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason;
        return [
            ...(v4.status === 'fulfilled' ? v4.value.map(address => ({ address, family: 4 })) : []),
            ...(v6.status === 'fulfilled' ? v6.value.map(address => ({ address, family: 6 })) : [])
        ];
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}

// URL keeps the brackets of an IPv6 literal host; net.isIP and the resolver take the bare address.
function hostnameOf(url: URL): string {
    return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

// A lookup that answers with checked addresses only, so the connection goes nowhere else: those of the family asked for (with ADDRCONFIG, of a family the host has a non-loopback, non-link-local address of), all of them when asked for all (Node then tries each), else the first.
function pinnedTo(addresses: readonly LookupAddress[]): LookupFunction {
    return (hostname, options, callback) => {
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const asked = family === 4 || family === 6 ? addresses.filter(address => address.family === family) : addresses;
        const answers = ((options.hints ?? 0) & dns.ADDRCONFIG) === 0 ? asked : configured(asked);
        const [first] = answers;
        if (first === undefined) {
            callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }), []);
        } else if (options.all) {
            callback(null, [...answers]);
        } else {
            callback(null, first.address, first.family);
        }
    };
}

// As ADDRCONFIG: the addresses of a family the host has an interface address of, not internal or link-local; all of them when that leaves none or the interfaces cannot be read.
function configured(addresses: readonly LookupAddress[]): readonly LookupAddress[] {
    let interfaces: ReturnType<typeof os.networkInterfaces>;
    try {
        interfaces = os.networkInterfaces();
    } catch {
        return addresses;
    }
    const families = new Set<number>();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (!entry.internal && !LINK_LOCAL.test(entry.address)) families.add(entry.family === 'IPv6' ? 6 : 4);
        }
    }
    const kept = addresses.filter(address => families.has(address.family));
    return kept.length === 0 ? addresses : kept;
}

// Certificate, verification and handshake failures are tls_error; every other failure (refused, reset, unreachable, unresolved) is connection_refused.
function failureOf(error: unknown): WebhookSendOutcome {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && TLS_FAILURE_CODE.test(code) ? { error: 'tls_error' } : REFUSED;
}
