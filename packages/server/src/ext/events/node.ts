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

import { isSpecialPurposeAddress } from './specialAddresses';
import type { WebhookSender, WebhookSendOutcome, WebhookSendRequest } from './types';

const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65_536;
const REFUSED: WebhookSendOutcome = { error: 'connection_refused' };
// OpenSSL certificate and verification codes, Node's TLS and OpenSSL error codes, and EPROTO, which Node reports for a failed TLS handshake.
const TLS_FAILURE_CODE = /CERT|UNABLE_TO_VERIFY|INVALID_CA|SELF_SIGNED|DEPTH_ZERO|^ERR_SSL_|^ERR_TLS_|^EPROTO$/;

/**
 * The default {@linkcode WebhookSender} for Node.js, hardened against
 * server-side request forgery. Unless the URL's origin is in `trustedOrigins`,
 * it requires `https`, resolves the host at every send, refuses with
 * `connection_refused` when any resolved address is in an IANA special-purpose
 * range (loopback, private, link-local and the like), and connects to the
 * checked address with the URL's host name in the `Host` header and TLS SNI.
 * It follows no redirects (a 3xx answer is returned as it is), gives up after
 * 5 seconds with `{ error: 'timeout' }`, and reads at most 64 KiB of the
 * response body.
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
            const addresses = await untilAborted(dns.promises.lookup(hostnameOf(url), { all: true }), deadline.signal);
            const [first] = addresses;
            if (first === undefined || addresses.some(({ address }) => isSpecialPurposeAddress(address))) return REFUSED;
            lookup = pinnedTo(first);
        }
        return await post(url, request, lookup, deadline.signal);
    } catch (error) {
        return timedOut ? { error: 'timeout' } : failureOf(error);
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', stop);
    }
}

// One POST; it rejects on a connection or TLS failure, and once `signal` aborts.
function post(url: URL, request: WebhookSendRequest, lookup: LookupFunction | undefined, signal: AbortSignal): Promise<WebhookSendOutcome> {
    return new Promise((resolve, reject) => {
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

// Settles as `promise` does, or rejects once `signal` aborts; a DNS lookup cannot itself be cancelled.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

// URL keeps the brackets of an IPv6 literal host; the resolver takes the bare address.
function hostnameOf(url: URL): string {
    return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

// A lookup that answers with the checked address only, so the connection goes nowhere else.
function pinnedTo({ address, family }: LookupAddress): LookupFunction {
    return (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
    };
}

// Certificate, verification and handshake failures are tls_error; every other failure (refused, reset, unreachable, unresolved) is connection_refused.
function failureOf(error: unknown): WebhookSendOutcome {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && TLS_FAILURE_CODE.test(code) ? { error: 'tls_error' } : REFUSED;
}
