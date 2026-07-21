import type { FetchLike } from '@modelcontextprotocol/core-internal';
import { createFetchWithInit, normalizeHeaders, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';

/**
 * Redirect handling for MCP requests. `'manual'` (default): GET redirects are
 * followed (bounded); cross-origin hops carry only request-descriptive
 * headers; POST/DELETE redirects surface as errors. `'follow'` delegates
 * redirect handling to the fetch implementation. See the migration guide for
 * details.
 */
export type RedirectPolicy = 'manual' | 'follow';

/** Maximum `Location` hops a transport `GET` follows under the `'manual'` policy. */
export const MAX_TRANSPORT_REDIRECT_HOPS = 3;

const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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

        if (method !== 'GET') {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpRedirectNotFollowed,
                `Server answered ${method} with a redirect (HTTP ${status}${location ? ` to ${location}` : ''}); ` +
                    `${method} requests are not re-sent to redirect targets — point the transport at the new endpoint or set redirectPolicy: 'follow'`,
                { status, statusText }
            );
        }
        if (location === null) {
            throw new SdkHttpError(
                SdkErrorCode.ClientHttpRedirectNotFollowed,
                `Server answered GET with a redirect (HTTP ${status}) without a Location header`,
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
