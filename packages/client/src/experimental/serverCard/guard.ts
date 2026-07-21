import type { FetchLike } from '@modelcontextprotocol/core-internal';

import { ServerCardError } from './errors';

/**
 * Options shared by every Server Card discovery fetcher.
 *
 * The defaults are the hardened choices from the extension's best-practices
 * guidance: HTTPS only, private and link-local address classes rejected,
 * response size capped, redirects bounded and re-validated on every hop, and
 * requests sent without cookies, credentials, or ambient auth.
 *
 * Honest limit: the URL guards are hostname-level string and address checks.
 * They cannot see where DNS actually resolves, so they do not defend against
 * DNS rebinding. For that depth, inject a DNS-pinning `fetch`.
 */
export interface DiscoveryFetchOptions {
    /**
     * Fetch implementation used for every request. Compose `withOAuth`,
     * middleware, or a DNS-pinning fetch here; the URL guards still apply
     * around whatever fetch is supplied.
     */
    fetch?: FetchLike;

    /** Abort signal threaded through every request. */
    signal?: AbortSignal;

    /**
     * Maximum response body size in bytes. Counted while streaming; the read
     * aborts over the cap. Defaults to 1 MiB (1_048_576).
     */
    maxResponseBytes?: number;

    /**
     * Maximum redirect hops. Every hop is re-validated by the URL guards.
     * Defaults to 3.
     */
    maxRedirects?: number;

    /**
     * Allow plain `http:` URLs beyond the always-exempt local-dev hosts
     * (`localhost`, `127.0.0.1`, `[::1]`). Defaults to `false`: the spec
     * requires HTTPS in production.
     */
    allowHttp?: boolean;

    /**
     * Allow IP-literal hosts in loopback, link-local (including
     * `169.254.169.254`), private (RFC 1918), and unique-local ranges, plus
     * single-label hostnames other than `localhost`. Not needed for the
     * always-exempt local-dev hosts (`localhost`, `127.0.0.1`, `[::1]`).
     * Defaults to `false`.
     */
    allowPrivateHosts?: boolean;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_MAX_REDIRECTS = 3;

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseIpv4(host: string): [number, number, number, number] | undefined {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!match) {
        return undefined;
    }
    const octets = match.slice(1).map(Number) as [number, number, number, number];
    return octets.every(octet => octet <= 255) ? octets : undefined;
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
    const [a, b] = octets;
    return (
        a === 0 || // 0.0.0.0/8
        a === 10 || // 10.0.0.0/8
        a === 127 || // 127.0.0.0/8 loopback
        (a === 169 && b === 254) || // 169.254.0.0/16 link-local, incl. 169.254.169.254
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) // 192.168.0.0/16
    );
}

/** Expands an IPv6 literal (brackets already stripped) to its 8 16-bit words. */
function ipv6Words(ipv6: string): number[] | undefined {
    let groupsText = ipv6;
    // Rewrite a trailing dotted-quad tail (`…:a.b.c.d`) as two hex words.
    if (groupsText.includes('.')) {
        const tailStart = groupsText.lastIndexOf(':');
        const tail = parseIpv4(groupsText.slice(tailStart + 1));
        if (tail === undefined) {
            return undefined;
        }
        const [a, b, c, d] = tail;
        groupsText = `${groupsText.slice(0, tailStart + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = groupsText.split('::');
    if (halves.length > 2) {
        return undefined;
    }
    const wordsOf = (half: string): number[] | undefined => {
        if (half === '') {
            return [];
        }
        const words: number[] = [];
        for (const group of half.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(group)) {
                return undefined;
            }
            words.push(Number.parseInt(group, 16));
        }
        return words;
    };
    const head = wordsOf(halves[0]!);
    const tail = halves.length === 2 ? wordsOf(halves[1]!) : [];
    if (head === undefined || tail === undefined) {
        return undefined;
    }
    if (halves.length === 1) {
        return head.length === 8 ? head : undefined;
    }
    if (head.length + tail.length > 7) {
        return undefined;
    }
    return [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail];
}

/** The IPv4 address embedded in two adjacent 16-bit words. */
function embeddedIpv4Of(words: number[], index: number): [number, number, number, number] {
    const high = words[index]!;
    const low = words[index + 1]!;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

const NAT64_PREFIX = [0x64, 0xff_9b, 0, 0, 0, 0]; // 64:ff9b::/96

function isPrivateIpv6(host: string): boolean {
    const words = ipv6Words(host.slice(1, -1).toLowerCase());
    if (words === undefined) {
        return true; // unparseable IPv6 literal: fail closed
    }
    if ((words[0]! & 0xff_c0) === 0xfe_80) {
        return true; // fe80::/10 link-local
    }
    if ((words[0]! & 0xfe_00) === 0xfc_00) {
        return true; // fc00::/7 unique-local
    }
    if (words[0] === 0x20_02) {
        return isPrivateIpv4(embeddedIpv4Of(words, 1)); // 2002::/16 6to4
    }
    if (NAT64_PREFIX.every((word, index) => words[index] === word)) {
        return isPrivateIpv4(embeddedIpv4Of(words, 6)); // NAT64 well-known prefix
    }
    if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xff_ff)) {
        // ::ffff:a.b.c.d IPv4-mapped and ::a.b.c.d IPv4-compatible forms.
        // Also covers `::` and `::1`: 0.0.0.0/8 is a private IPv4 range.
        return isPrivateIpv4(embeddedIpv4Of(words, 6));
    }
    return false;
}

/**
 * Applies the discovery URL guards to one URL (one redirect hop). Throws
 * `ServerCardError` with code `'blocked-host'` on rejection.
 */
export function assertAllowedUrl(url: URL, options: DiscoveryFetchOptions): void {
    const host = url.hostname;
    if (url.protocol !== 'https:') {
        if (url.protocol !== 'http:') {
            throw new ServerCardError('blocked-host', `Discovery URLs must be http(s), got ${url.protocol}`, { url: url.href });
        }
        if (!options.allowHttp && !LOCAL_DEV_HOSTS.has(host)) {
            throw new ServerCardError('blocked-host', 'Discovery over plain HTTP is limited to localhost; use HTTPS', {
                url: url.href
            });
        }
    }
    if (LOCAL_DEV_HOSTS.has(host)) {
        // Loopback by IP literal is no more dangerous than loopback by name:
        // the local-dev hosts are exempt from the address-class checks too.
        return;
    }
    if (options.allowPrivateHosts) {
        return;
    }
    if (host.startsWith('[')) {
        if (isPrivateIpv6(host)) {
            throw new ServerCardError('blocked-host', `IPv6 host ${host} is in a private or local address range`, { url: url.href });
        }
        return;
    }
    const ipv4 = parseIpv4(host);
    if (ipv4 !== undefined) {
        if (isPrivateIpv4(ipv4)) {
            throw new ServerCardError('blocked-host', `IPv4 host ${host} is in a private or local address range`, { url: url.href });
        }
        return;
    }
    if (!host.includes('.')) {
        throw new ServerCardError('blocked-host', `Single-label hostname ${host} is not allowed for discovery`, { url: url.href });
    }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The guarded request pipeline shared by the fetchers: validates the URL,
 * sends a credential-free GET with the given `Accept` (and optional
 * `If-None-Match`), and follows redirects manually so every hop passes the
 * URL guards again. Returns the final response and the final URL.
 */
export async function guardedFetch(
    url: URL,
    accept: string,
    options: DiscoveryFetchOptions,
    etag?: string
): Promise<{ response: Response; url: string }> {
    const fetchFn = options.fetch ?? fetch;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let current = url;
    for (let hop = 0; ; hop++) {
        assertAllowedUrl(current, options);
        const headers: Record<string, string> = { Accept: accept };
        if (etag !== undefined) {
            headers['If-None-Match'] = etag;
        }
        // No cookies, no credentials, no ambient auth: discovery requests
        // carry nothing beyond Accept and the optional validator.
        const response = await fetchFn(current.href, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            signal: options.signal,
            headers
        });
        if (!REDIRECT_STATUSES.has(response.status)) {
            return { response, url: current.href };
        }
        const location = response.headers.get('location');
        if (location === null) {
            throw new ServerCardError('http-error', `Redirect status ${response.status} without a Location header`, {
                url: current.href,
                status: response.status
            });
        }
        if (hop >= maxRedirects) {
            throw new ServerCardError('too-many-redirects', `More than ${maxRedirects} redirects while fetching ${url.href}`, {
                url: current.href
            });
        }
        current = new URL(location, current);
    }
}

/**
 * Reads a response body as text with a streamed byte cap. Throws
 * `ServerCardError` with code `'response-too-large'` over the cap.
 *
 * A response without a readable `body` stream — only reachable through a
 * caller-supplied `FetchLike`; native fetch responses expose one for every
 * non-empty body — falls back to `text()`, so on that branch the cap is
 * enforced only after the full body has been buffered.
 */
export async function readBodyWithCap(response: Response, url: string, maxBytes: number): Promise<string> {
    if (response.body === null) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
            throw new ServerCardError('response-too-large', `Response from ${url} exceeds ${maxBytes} bytes`, { url });
        }
        return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new ServerCardError('response-too-large', `Response from ${url} exceeds ${maxBytes} bytes`, { url });
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}
