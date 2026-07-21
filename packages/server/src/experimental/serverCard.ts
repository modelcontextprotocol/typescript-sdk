import type {
    AICatalog,
    AICatalogEntry,
    AICatalogHost,
    ServerCard,
    ServerCardRemote,
    ServerCardRepository
} from '@modelcontextprotocol/core/experimental/server-card';
import {
    AI_CATALOG_MEDIA_TYPE,
    AI_CATALOG_WELL_KNOWN_PATH,
    AICatalogEntrySchema,
    AICatalogSchema,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_PATH_SUFFIX,
    SERVER_CARD_SCHEMA_URL,
    ServerCardSchema
} from '@modelcontextprotocol/core/experimental/server-card';
import type { Icon, Implementation } from '@modelcontextprotocol/core-internal';

// Experimental Server Card serving helpers (SEP-2127). Mirrors the
// build-then-respond shape of ../server/middleware/oauthMetadata.ts: pure
// builders that validate at startup, plus web-standard responders that match
// synchronously and fall through with `undefined`.

/**
 * Options for {@link buildServerCard}.
 */
export interface BuildServerCardOptions {
    /**
     * Server name in reverse-DNS format with exactly one slash, e.g.
     * `'com.example/weather'`. Cannot be derived from anything else, so it is
     * always explicit.
     */
    name: string;

    /**
     * Human-readable, capabilities-focused description. Required, 1 to 100
     * characters.
     */
    description: string;

    /**
     * Prefills `version`, `title`, `websiteUrl`, and `icons` from your
     * server's `serverInfo` Implementation. Explicit options win over these
     * prefills.
     */
    serverInfo?: Implementation;

    /**
     * Exact version string. Required unless `serverInfo` is given. Version
     * ranges are rejected.
     */
    version?: string;

    /** Display name, 1 to 100 characters. */
    title?: string;

    /** Homepage or documentation URL. */
    websiteUrl?: string;

    /** Icons the client can display. */
    icons?: Icon[];

    /** Source repository metadata. */
    repository?: ServerCardRepository;

    /**
     * Remote endpoints. These MUST reflect the real endpoints your server
     * exposes; the spec requires the card to stay consistent with runtime
     * behavior.
     */
    remotes?: ServerCardRemote[];

    /** Extension metadata, keys reverse-DNS prefixed. */
    _meta?: Record<string, unknown>;
}

/**
 * Builds and validates a Server Card. `$schema` is always
 * {@link SERVER_CARD_SCHEMA_URL} and is not an input, so a card built here can
 * never be mis-pinned. Call this at startup: an invalid card is a boot error,
 * never a broken production document. Throws `ZodError` on any constraint
 * violation.
 *
 * Cards MUST NOT contain credentials, tokens, internal network topology, or
 * private endpoints. Everything in a card is public.
 */
export function buildServerCard(options: BuildServerCardOptions): ServerCard {
    const card: Record<string, unknown> = {
        $schema: SERVER_CARD_SCHEMA_URL,
        name: options.name,
        version: options.version ?? options.serverInfo?.version,
        description: options.description,
        title: options.title ?? options.serverInfo?.title,
        websiteUrl: options.websiteUrl ?? options.serverInfo?.websiteUrl,
        icons: options.icons ?? options.serverInfo?.icons,
        repository: options.repository,
        remotes: options.remotes,
        _meta: options._meta
    };
    for (const key of Object.keys(card)) {
        if (card[key] === undefined) {
            delete card[key];
        }
    }
    return ServerCardSchema.parse(card);
}

/**
 * Computes the reserved card location for a streamable HTTP endpoint:
 * `'https://host/mcp'` becomes `'https://host/mcp/server-card'`. The suffix
 * is appended to the MCP path, never to the origin.
 */
export function getServerCardUrl(mcpUrl: URL | string): string {
    const url = new URL(mcpUrl);
    const path = stripTrailingSlash(url.pathname);
    url.pathname = `${path === '/' ? '' : path}${SERVER_CARD_PATH_SUFFIX}`;
    url.search = '';
    url.hash = '';
    return url.href;
}

/**
 * Options for {@link serverCardResponse}.
 */
export interface ServerCardResponseOptions {
    /**
     * The card to serve, as given. Validate it once at startup with
     * {@link buildServerCard}; the responder never re-validates per request.
     */
    card: ServerCard;

    /**
     * Public streamable HTTP endpoint of this server. The matched route is
     * the path of `getServerCardUrl(mcpUrl)`.
     */
    mcpUrl: URL | string;

    /**
     * `Cache-Control` header value. Defaults to `'public, max-age=3600'`
     * (spec SHOULD). Pass `false` to omit the header.
     */
    cacheControl?: string | false;

    /**
     * Serve a strong SHA-256 `ETag` and answer `If-None-Match` with `304`.
     * Defaults to `true`.
     */
    etag?: boolean;
}

/**
 * Serves a Server Card from a web-standard `fetch(request)` handler at the
 * reserved `<streamable-http-url>/server-card` location.
 *
 * Matching is synchronous: unmatched paths return `undefined` immediately so
 * handlers compose under a single await. The bare MCP endpoint is never
 * matched; its GET stays reserved for the SSE stream.
 *
 * Responses carry the spec-required permissive CORS headers, the
 * `application/mcp-server-card+json` media type, a `Cache-Control` header,
 * and a strong ETag with `If-None-Match` conditional handling.
 *
 * Under an exact mount like `app.all('/mcp', ...)`, `GET /mcp/server-card`
 * never reaches the MCP handler. Compose this responder in front of it, or
 * use `mcpServerCardRouter` from `@modelcontextprotocol/express`.
 *
 * @example
 * ```ts source="./serverCard.examples.ts#serverCardResponse_fetchHandler"
 * async function fetchHandler(request: Request): Promise<Response> {
 *     return await (serverCardResponse(request, { card, mcpUrl }) ?? aiCatalogResponse(request, { catalog }) ?? serveMcp(request));
 * }
 * ```
 */
export function serverCardResponse(request: Request, options: ServerCardResponseOptions): Promise<Response> | undefined {
    const targetPath = stripTrailingSlash(new URL(getServerCardUrl(options.mcpUrl)).pathname);
    const requestPath = stripTrailingSlash(new URL(request.url).pathname);
    if (requestPath !== targetPath) {
        return undefined;
    }
    return documentResponse(request, options.card, SERVER_CARD_MEDIA_TYPE, options);
}

/**
 * Options for {@link aiCatalogResponse}.
 */
export interface AICatalogResponseOptions {
    /**
     * The catalog to serve, as given. Validate it once at startup with
     * {@link buildAICatalog}.
     */
    catalog: AICatalog;

    /**
     * Route to serve the catalog at. Defaults to
     * `'/.well-known/ai-catalog.json'`. Best practice is to publish the
     * catalog on the domain users associate with the service, which may not
     * be the API host serving MCP traffic.
     */
    path?: string;

    /**
     * `Cache-Control` header value. Defaults to `'public, max-age=3600'`.
     * Pass `false` to omit the header.
     */
    cacheControl?: string | false;

    /**
     * Serve a strong SHA-256 `ETag` and answer `If-None-Match` with `304`.
     * Defaults to `true`.
     */
    etag?: boolean;
}

/**
 * Serves an AI Catalog from a web-standard `fetch(request)` handler at
 * `/.well-known/ai-catalog.json` (or `options.path`). Same matching,
 * CORS, caching, and ETag behavior as {@link serverCardResponse}, with the
 * `application/ai-catalog+json` media type.
 */
export function aiCatalogResponse(request: Request, options: AICatalogResponseOptions): Promise<Response> | undefined {
    const targetPath = stripTrailingSlash(options.path ?? AI_CATALOG_WELL_KNOWN_PATH);
    const requestPath = stripTrailingSlash(new URL(request.url).pathname);
    if (requestPath !== targetPath) {
        return undefined;
    }
    return documentResponse(request, options.catalog, AI_CATALOG_MEDIA_TYPE, options);
}

/**
 * Builds a validated AI Catalog entry for a card.
 *
 * The identifier is the spec's 4-segment URN
 * `urn:air:{publisher}:mcp:{server}` where the publisher is the card name's
 * reverse-DNS namespace re-reversed to a domain: `'com.example/weather'`
 * becomes `'urn:air:example.com:mcp:weather'`. The entry type is always
 * `application/mcp-server-card+json`.
 *
 * Pass `{ url }` for a hosted entry pointing at the card's URL, or
 * `{ inline: true }` to embed the card itself as the entry's `data`. The
 * entry deliberately does not duplicate the card's human-readable fields;
 * per the spec, clients read `title` and `description` from the card.
 */
export function serverCardCatalogEntry(card: ServerCard, location: { url: URL | string } | { inline: true }): AICatalogEntry {
    const slash = card.name.indexOf('/');
    const namespace = card.name.slice(0, slash);
    const serverName = card.name.slice(slash + 1);
    const publisher = namespace.split('.').toReversed().join('.');
    return AICatalogEntrySchema.parse({
        identifier: `urn:air:${publisher}:mcp:${serverName}`,
        type: SERVER_CARD_MEDIA_TYPE,
        ...('url' in location ? { url: new URL(location.url).href } : { data: card })
    });
}

/**
 * Builds and validates an AI Catalog document with `specVersion: '1.0'`.
 * Throws `ZodError` on an invalid entry (for example one carrying both `url`
 * and `data`). Call at startup, like {@link buildServerCard}.
 */
export function buildAICatalog(init: { entries: AICatalogEntry[]; host?: AICatalogHost }): AICatalog {
    return AICatalogSchema.parse({
        specVersion: '1.0',
        entries: init.entries,
        ...(init.host === undefined ? {} : { host: init.host })
    });
}

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const DEFAULT_CACHE_CONTROL = 'public, max-age=3600';

interface DocumentResponseOptions {
    cacheControl?: string | false;
    etag?: boolean;
}

async function documentResponse(
    request: Request,
    document: object,
    mediaType: string,
    options: DocumentResponseOptions
): Promise<Response> {
    // Discovery documents must be fetchable from web-based MCP clients on any
    // origin, so every response carries permissive CORS headers (spec MUST).
    if (request.method === 'OPTIONS') {
        const requestedHeaders = request.headers.get('access-control-request-headers');
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': ALLOWED_METHODS,
                // The reflected allow-list makes the response vary by request
                // (a client revalidating with If-None-Match preflights that
                // header, which is not CORS-safelisted): without Vary a shared
                // cache would replay one preflight's allow-list against
                // another's headers.
                ...(requestedHeaders === null
                    ? {}
                    : { 'Access-Control-Allow-Headers': requestedHeaders, Vary: 'Access-Control-Request-Headers' })
            }
        });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Response.json(
            { error: 'method_not_allowed', error_description: `The method ${request.method} is not allowed for this endpoint` },
            { status: 405, headers: { Allow: ALLOWED_METHODS, 'Access-Control-Allow-Origin': '*' } }
        );
    }

    const body = JSON.stringify(document);
    const headers: Record<string, string> = { 'Access-Control-Allow-Origin': '*' };
    const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
    if (cacheControl !== false) {
        headers['Cache-Control'] = cacheControl;
    }

    if (options.etag !== false) {
        const etag = await strongEtagOf(body);
        headers['ETag'] = etag;
        if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
            return new Response(null, { status: 304, headers });
        }
    }

    headers['Content-Type'] = mediaType;
    // RFC 9110: HEAD is GET without the body, same headers.
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

/** Strong ETag: quoted hex SHA-256 of the exact body bytes. */
async function strongEtagOf(body: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `"${hex}"`;
}

/**
 * RFC 9110 If-None-Match evaluation for a strong validator: `*` matches any
 * representation; list members compare by exact validator; a weak `W/` entry
 * never strong-matches.
 */
function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
    if (header === null) {
        return false;
    }
    return header.split(',').some(candidate => {
        const trimmed = candidate.trim();
        return trimmed === '*' || trimmed === etag;
    });
}

function stripTrailingSlash(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

// Re-exported so server authors import everything from one module. Types and
// constants only; the Zod schemas stay on the core subpath.
export type {
    AICatalog,
    AICatalogEntry,
    AICatalogHost,
    ServerCard,
    ServerCardRemote,
    ServerCardRepository
} from '@modelcontextprotocol/core/experimental/server-card';
export {
    AI_CATALOG_MEDIA_TYPE,
    AI_CATALOG_WELL_KNOWN_PATH,
    SERVER_CARD_MEDIA_TYPE,
    SERVER_CARD_PATH_SUFFIX,
    SERVER_CARD_SCHEMA_URL
} from '@modelcontextprotocol/core/experimental/server-card';
