import type { FetchLike } from '@modelcontextprotocol/core-internal';
import { createFetchWithInit, normalizeHeaders, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';

/**
 * Redirect handling for MCP requests.
 *
 * - `'manual'` (default): the transport applies RFC 9110 semantics itself,
 *   bounded at {@linkcode MAX_TRANSPORT_REDIRECT_HOPS} hops. `GET` redirects
 *   are followed; cross-origin hops carry only request-descriptive headers.
 *   `POST`/`DELETE` follow a same-origin `307`/`308` (method and body
 *   preserved); a same-origin `301`/`302`/`303` (platforms re-send those as
 *   `GET`) or any cross-origin redirect surfaces as an error.
 * - `'follow'`: delegates redirect handling to the `fetch` implementation.
 * - `'error'`: every redirect answer surfaces as an error.
 *
 * See the migration guide for details.
 */
export type RedirectPolicy = 'manual' | 'follow' | 'error';

/** Maximum `Location` hops a transport request follows under the `'manual'` policy. */
export const MAX_TRANSPORT_REDIRECT_HOPS = 3;

/** Response statuses the client treats as redirects (RFC 9110 §15.4 with a `Location`-carrying semantic). */
export const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Headers a followed SSE `GET` hop carries once it leaves the endpoint's
 * origin: only what the target needs to negotiate the media type, parse the
 * request, and resume the stream. Connection-scoped headers (`Authorization`,
 * `Mcp-Session-Id`, `requestInit` extras) are deliberately absent.
 */
export function crossOriginSseGetHeaders(protocolVersion?: string, resumptionToken?: string): Headers {
    const headers = new Headers({ accept: 'text/event-stream' });
    if (protocolVersion) {
        headers.set('mcp-protocol-version', protocolVersion);
    }
    if (resumptionToken) {
        headers.set('last-event-id', resumptionToken);
    }
    return headers;
}

export interface TransportFetchArgs {
    fetchFn: FetchLike;
    url: URL | string;
    method: 'GET' | 'POST' | 'DELETE';
    /** Fully-derived headers for requests to the configured endpoint. */
    headers: Headers;
    /** Connection-level `RequestInit`; applied to same-origin requests only. */
    requestInit?: RequestInit;
    body?: string;
    signal?: AbortSignal;
    redirectPolicy: RedirectPolicy;
    /** Headers used once a followed `GET` hop leaves the endpoint's origin. */
    crossOriginHeaders?: Headers;
}

/**
 * Issues the request under {@linkcode RedirectPolicy}; redirects that are not
 * followed surface as `SdkHttpError` with code `ClientHttpRedirectNotFollowed`.
 */
export async function fetchWithRedirectPolicy(args: TransportFetchArgs): Promise<Response> {
    const { fetchFn, method, headers, requestInit, body, signal, redirectPolicy } = args;
    if (redirectPolicy === 'follow') {
        return fetchFn(args.url, { ...requestInit, method, headers, body, signal });
    }

    const initialUrl = args.url instanceof URL ? args.url : new URL(args.url);
    let currentUrl = initialUrl;
    // Latched: once a chain leaves the origin, header dropping is never undone.
    let leftOrigin = false;
    let response = await fetchFn(currentUrl, { ...requestInit, method, headers, body, signal, redirect: 'manual' });
    throwIfRedirectFiltered(response, method);

    for (let hop = 0; REDIRECT_STATUS_CODES.has(response.status); hop++) {
        const { status, statusText } = response;
        const location = response.headers.get('location');
        // Release the redirect response before erroring or following.
        await response.text?.().catch(() => {});

        if (redirectPolicy === 'error') {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpRedirectNotFollowed,
                `Server answered ${method} with a redirect (HTTP ${status}${location ? ` to ${location}` : ''}); ` +
                    `redirectPolicy: 'error' treats every redirect as terminal — point the transport at the endpoint's final URL`,
                { status, statusText }
            );
        }
        if (location === null) {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpRedirectNotFollowed,
                `Server answered ${method} with a redirect (HTTP ${status}) without a Location header`,
                { status, statusText }
            );
        }
        if (hop >= MAX_TRANSPORT_REDIRECT_HOPS) {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpRedirectNotFollowed,
                `Redirect limit of ${MAX_TRANSPORT_REDIRECT_HOPS} hops exceeded (last target: ${location})`,
                { status, statusText }
            );
        }
        let nextUrl: URL;
        try {
            nextUrl = new URL(location, currentUrl);
        } catch {
            throw new SdkHttpError(SdkErrorCode.ClientHttpRedirectNotFollowed, `Redirect Location "${location}" is not a valid URL`, {
                status,
                statusText
            });
        }

        if (method !== 'GET') {
            // Origin = exact scheme+host+port match (URL.origin) — deliberately
            // no subdomain or same-site leniency, and an http→https upgrade is
            // a different origin.
            if (nextUrl.origin !== initialUrl.origin) {
                throw new SdkHttpError(
                    SdkErrorCode.ClientHttpRedirectNotFollowed,
                    `Server answered ${method} with a redirect (HTTP ${status}) to a different origin (${nextUrl.origin}); ` +
                        `${method} requests are not re-sent across origins — point the transport at the new endpoint or set redirectPolicy: 'follow'`,
                    { status, statusText }
                );
            }
            if (status !== 307 && status !== 308) {
                // Platforms re-send a 301/302/303-answered POST as GET
                // (RFC 9110 §15.4), which would corrupt an MCP request.
                const slashHint = differsOnlyByTrailingSlash(currentUrl, nextUrl)
                    ? ` — the target differs from the request URL only by a trailing slash; point the transport at ${nextUrl.href}`
                    : ` — point the transport at the endpoint's final URL, or set redirectPolicy: 'follow' to delegate to the fetch implementation`;
                throw new SdkHttpError(
                    SdkErrorCode.ClientHttpRedirectNotFollowed,
                    `Server answered ${method} with a redirect (HTTP ${status} to ${location}); following it would re-send the request as GET${slashHint}`,
                    { status, statusText }
                );
            }
            // Same-origin 307/308: re-send the identical request (full headers —
            // same origin, nothing to scrub). Unbreaks trailing-slash fronts
            // (e.g. framework mounts answering /mcp with a 307 to /mcp/).
            currentUrl = nextUrl;
            response = await fetchFn(currentUrl, { ...requestInit, method, headers, body, signal, redirect: 'manual' });
            throwIfRedirectFiltered(response, method);
            continue;
        }

        currentUrl = nextUrl;
        leftOrigin ||= nextUrl.origin !== initialUrl.origin;
        response = leftOrigin
            ? await fetchFn(currentUrl, {
                  method: 'GET',
                  headers: args.crossOriginHeaders ?? new Headers(),
                  signal,
                  redirect: 'manual'
              })
            : await fetchFn(currentUrl, { ...requestInit, method: 'GET', headers, signal, redirect: 'manual' });
        throwIfRedirectFiltered(response, 'GET');
    }

    return response;
}

/** Same origin and path, where the paths differ only by a trailing slash (the common framework-mount redirect shape). */
function differsOnlyByTrailingSlash(from: URL, to: URL): boolean {
    if (from.origin !== to.origin || from.pathname === to.pathname) {
        return false;
    }
    return trimTrailingSlashes(from.pathname) === trimTrailingSlashes(to.pathname);
}

/**
 * Linear-time trailing-slash trim. The input derives from a server-controlled
 * `Location` header, so no regex — a quantified pattern would backtrack
 * superlinearly on a pathological run of slashes.
 */
function trimTrailingSlashes(pathname: string): string {
    let end = pathname.length;
    while (end > 0 && pathname.codePointAt(end - 1) === 0x2f /* '/' */) {
        end--;
    }
    return pathname.slice(0, end);
}

export interface TransportHttpOptions {
    url: URL;
    fetch?: FetchLike;
    requestInit?: RequestInit;
    oauthRequestInit?: RequestInit;
    redirectPolicy?: RedirectPolicy;
}

/**
 * Sole holder of a client transport's HTTP configuration (endpoint URL,
 * fetch, `requestInit`, redirect policy); transports issue requests through
 * it rather than holding those as fields.
 */
export interface TransportHttp {
    /** `POST` targets the message endpoint once set; `GET`/`DELETE` always target the configured URL. */
    mcpRequest(
        method: 'GET' | 'POST' | 'DELETE',
        headers: Headers,
        body?: string,
        signal?: AbortSignal,
        crossOriginHeaders?: Headers
    ): Promise<Response>;
    /** Merges `oauthRequestInit`, never `requestInit`. */
    readonly oauthFetch: FetchLike;
    /** Headers contributed by `requestInit`, for merging into derived request headers. */
    requestInitHeaders(): Record<string, string>;
    /** Legacy SSE only: where subsequent `POST`s go. Must share the configured URL's origin. */
    setMessageEndpoint(endpoint: URL): void;
    readonly messageEndpoint: URL | undefined;
    /** `GET` for the EventSource integration, which supplies its own fetch and per-request init. */
    eventSourceGet(args: {
        fetchOverride?: FetchLike;
        url: URL | string;
        headers: Headers;
        requestInit?: RequestInit;
        signal?: AbortSignal;
        crossOriginHeaders?: Headers;
    }): Promise<Response>;
}

export function createTransportHttp(opts: TransportHttpOptions): TransportHttp {
    const { url, requestInit } = opts;
    const redirectPolicy = opts.redirectPolicy ?? 'manual';
    let messageEndpoint: URL | undefined;
    return {
        mcpRequest(method, headers, body, signal, crossOriginHeaders) {
            return fetchWithRedirectPolicy({
                fetchFn: opts.fetch ?? fetch,
                url: method === 'POST' ? (messageEndpoint ?? url) : url,
                method,
                headers,
                requestInit,
                body,
                signal,
                redirectPolicy,
                crossOriginHeaders
            });
        },
        oauthFetch: createFetchWithInit(opts.fetch, opts.oauthRequestInit),
        requestInitHeaders: () => normalizeHeaders(requestInit?.headers),
        setMessageEndpoint(endpoint) {
            if (endpoint.origin !== url.origin) {
                throw new Error(`Endpoint origin does not match connection origin: ${endpoint.origin}`);
            }
            messageEndpoint = endpoint;
        },
        get messageEndpoint() {
            return messageEndpoint;
        },
        eventSourceGet(args) {
            return fetchWithRedirectPolicy({
                fetchFn: args.fetchOverride ?? opts.fetch ?? fetch,
                url: args.url,
                method: 'GET',
                headers: args.headers,
                requestInit: args.requestInit,
                signal: args.signal,
                redirectPolicy,
                crossOriginHeaders: args.crossOriginHeaders
            });
        }
    };
}

/**
 * A runtime-filtered redirect (Fetch `opaqueredirect`: status 0, no readable
 * `Location`) would otherwise fail status handling as an unexplained HTTP 0.
 */
function throwIfRedirectFiltered(response: Response, method: 'GET' | 'POST' | 'DELETE'): void {
    if (response.type !== 'opaqueredirect') {
        return;
    }
    throw new SdkHttpError(
        SdkErrorCode.ClientHttpRedirectNotFollowed,
        `Server answered ${method} with a redirect this runtime filters (opaqueredirect), so the target cannot be observed; ` +
            `set redirectPolicy: 'follow' or serve the MCP endpoint without redirects`,
        { status: 0, statusText: response.statusText }
    );
}
