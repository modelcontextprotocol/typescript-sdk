/**
 * URL policy validation for OAuth discovery flows.
 *
 * Client OAuth discovery adopts and fetches URLs that arrive over the network
 * (`WWW-Authenticate` challenges, protected-resource metadata, authorization-server
 * metadata). RFC 9728 §7.6 requires the client to verify it trusts an authorization
 * server before using it, and RFC 8414 §2 constrains what an issuer identifier may
 * look like. {@linkcode assertAllowedDiscoveryUrl} is the mechanical part of that
 * verification: a purpose-typed, fail-closed check that runs BEFORE any network I/O
 * on every discovery-derived URL.
 *
 * The default policy is deliberately derivable from the connection itself (no
 * app-specific values needed):
 *
 * 1. `https:` required everywhere; `http:` is permitted only for loopback hosts
 *    (the RFC 8252 §7.3 exemption behind `assertSecureTokenEndpoint`, here covering
 *    the full loopback set: `localhost` and its subdomains, 127/8 literals, `[::1]`).
 * 2. Locality symmetry ("no descent"): when the step that produced the URL (the
 *    MCP server, or the authorization server that published an endpoint) is a
 *    non-local host, discovery may not target loopback or private/link-local IP
 *    literals. DNS names are deliberately never resolved — an authorization server
 *    on a private `https:` DNS name (e.g. `https://idp.corp.internal`) stays
 *    deployable by default, and name-resolution-level controls remain a
 *    deployer/network-layer concern.
 * 3. Protected-resource metadata must be same-origin with the MCP server: RFC 9728 §3
 *    derives the well-known URL from the resource identifier itself, so conformant
 *    metadata is always same-origin.
 *
 * Every rule that can block a legitimate topology has exactly one named opt-out on
 * {@linkcode DiscoveryUrlPolicyOptions}, and every rejection is a typed
 * {@linkcode DiscoveryUrlBlockedError} whose message names that opt-out.
 */
import { brandedHasInstance, stampErrorBrands } from '../errors/crossBundleBrand';

/**
 * What a discovery-flow URL is about to be used for. Purposes that are fetched by
 * the SDK (`resource-metadata`, `as-metadata`, `token-endpoint`,
 * `registration-endpoint`, `redirect-hop`) are gated immediately before the request;
 * purposes that are adopted rather than fetched (`authorization-server`,
 * `authorization-endpoint`) are gated at adoption time.
 */
export type DiscoveryUrlPurpose =
    /** RFC 9728 protected-resource-metadata GET (`WWW-Authenticate`, caller option, or well-known derivation). */
    | 'resource-metadata'
    /** Adoption of an `authorization_servers[]` issuer, including restore from cached discovery state (asserted, not fetched). */
    | 'authorization-server'
    /** Each RFC 8414 / OpenID Connect discovery GET derived from the authorization server URL. */
    | 'as-metadata'
    /** Browser redirect target (asserted, never fetched by the SDK). */
    | 'authorization-endpoint'
    /** Token request POST target. */
    | 'token-endpoint'
    /** Dynamic client registration POST target. */
    | 'registration-endpoint'
    /** A `Location` target while manually following a redirect from a discovery GET. */
    | 'redirect-hop';

/**
 * Where a discovery-flow URL came from. The policy itself is source-independent;
 * call sites use the source to pick violation handling (e.g. a non-conformant
 * `WWW-Authenticate` URL can fall back to the SDK's own well-known derivation,
 * while an explicit caller option should fail loudly).
 */
export type DiscoveryUrlSource =
    /**
     * Relayed from a `WWW-Authenticate` challenge's `resource_metadata`
     * parameter. The client transports label the URLs they extract from a
     * challenge this way (`resourceMetadataUrlSource: 'www-authenticate'`);
     * an explicit URL whose provenance is not declared is labeled `'caller'`.
     */
    | 'www-authenticate'
    | 'protected-resource-metadata'
    | 'authorization-server-metadata'
    | 'sdk-derived'
    | 'cached-discovery-state'
    | 'caller';

/**
 * The step that produced a discovery-flow URL: the MCP server the flow runs
 * against (URLs adopted or derived during discovery — `resource-metadata`,
 * `authorization-server`) or the authorization server that published the URL
 * (the endpoint and metadata purposes — `as-metadata`, `authorization-endpoint`,
 * `token-endpoint`, `registration-endpoint`). Redirect hops carry the original
 * producer of the request being followed.
 */
export interface DiscoveryUrlProducer {
    /** The producing server's URL — the locality anchor for the no-descent rule. */
    url: URL;
    kind: 'mcp-server' | 'authorization-server';
}

/**
 * Everything known about a discovery-flow URL at the moment it is validated.
 * Carried on {@linkcode DiscoveryUrlBlockedError} so callers can report or handle
 * rejections precisely.
 */
export interface DiscoveryUrlContext {
    purpose: DiscoveryUrlPurpose;
    /** The exact URL about to be contacted or adopted. */
    url: URL;
    /**
     * The step that produced the URL. The no-descent locality rule compares
     * `url` against `producer.url`.
     */
    producer: DiscoveryUrlProducer;
    source: DiscoveryUrlSource;
    /** Set while manually following a redirect: the hop being validated. */
    redirectHop?: {
        from: URL;
        status: number;
        originalPurpose: Exclude<DiscoveryUrlPurpose, 'redirect-hop'>;
    };
}

/**
 * Options that relax individual rules of the default discovery URL policy.
 * All default to off — the policy fails closed. Each option maps to exactly one
 * rule, and rejection messages name the option that would have permitted the URL.
 */
export interface DiscoveryUrlPolicyOptions {
    /**
     * Permit `http:` discovery URLs on non-loopback hosts. By default `http:` is
     * accepted only for loopback hosts (`localhost` and its subdomains, 127/8
     * literals, `[::1]`) — the RFC 8252 §7.3 exemption also used by
     * `assertSecureTokenEndpoint`.
     */
    allowHttpDiscovery?: boolean;
    /**
     * Honor a protected-resource-metadata URL that is not same-origin with the MCP
     * server. RFC 9728 §3 derives the well-known metadata URL from the resource
     * identifier itself, so conformant metadata is always same-origin; this option
     * exists for gateway/CDN topologies that split the two.
     */
    allowCrossOriginResourceMetadata?: boolean;
    /**
     * Disable the locality-symmetry rule: allow discovery URLs whose host is a
     * loopback or private/link-local IP literal even when the producing step
     * (`ctx.producer` — the MCP server, or the authorization server that
     * published an endpoint) is a non-local host.
     */
    allowPrivateAddressTargets?: boolean;
}

/**
 * Thrown by {@linkcode assertAllowedDiscoveryUrl} when a discovery-flow URL fails
 * the URL policy. Always thrown before any network I/O and before any discovery
 * state is persisted.
 */
export class DiscoveryUrlBlockedError extends Error {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.DiscoveryUrlBlockedError' });
    }

    static override [Symbol.hasInstance](value: unknown): boolean {
        return brandedHasInstance(this, value);
    }

    /**
     * Brand-based type guard: equivalent to `value instanceof this`, as an
     * explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
     * the caller's own brand via `this`, so every branded subclass gets a
     * correctly-scoped guard by inheritance. Must be invoked on the class —
     * in callback position write `v => DiscoveryUrlBlockedError.isInstance(v)`, not
     * `.filter(DiscoveryUrlBlockedError.isInstance)` (detached calls throw rather
     * than silently matching nothing).
     */
    static isInstance<T extends abstract new (...args: never[]) => unknown>(this: T, value: unknown): value is InstanceType<T> {
        if (typeof this !== 'function') {
            throw new TypeError(
                'isInstance must be called on the class (e.g. `DiscoveryUrlBlockedError.isInstance(value)`); for callbacks use `v => DiscoveryUrlBlockedError.isInstance(v)`'
            );
        }
        return brandedHasInstance(this, value);
    }

    constructor(
        public readonly context: DiscoveryUrlContext,
        public readonly reason: string
    ) {
        super(`Discovery URL ${context.url.href} not allowed for purpose '${context.purpose}': ${reason}`);
        this.name = 'DiscoveryUrlBlockedError';
        stampErrorBrands(this, new.target);
    }
}

/** Hostnames treated as loopback for the `http:` exemption (RFC 8252 §7.3). */
function isLoopbackHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/** Parses a WHATWG-canonicalized dotted-quad IPv4 hostname into its four octets, or undefined for anything else. */
function parseIpv4(hostname: string): [number, number, number, number] | undefined {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!match) {
        return undefined;
    }
    const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    if (octets.some(octet => octet > 255)) {
        return undefined;
    }
    return octets as [number, number, number, number];
}

function isLocalIpv4(octets: [number, number, number, number]): boolean {
    const [a, b] = octets;
    return (
        a === 127 || // loopback (127/8)
        a === 10 || // private (10/8)
        (a === 172 && b >= 16 && b <= 31) || // private (172.16/12)
        (a === 192 && b === 168) || // private (192.168/16)
        (a === 169 && b === 254) || // link-local (169.254/16)
        (a === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0) // unspecified (0.0.0.0)
    );
}

/**
 * Classifies a bracketed, WHATWG-canonicalized IPv6 hostname (e.g. `[::1]`,
 * `[fe80::1]`, `[::ffff:7f00:1]`) as loopback/private/link-local.
 *
 * The WHATWG serializer emits pure hex groups (an IPv4-mapped literal like
 * `::ffff:127.0.0.1` arrives here as `[::ffff:7f00:1]`), so the mapped tail is
 * reconstructed into octets and re-checked against the IPv4 ranges.
 */
function isLocalIpv6(hostname: string): boolean {
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
        return false;
    }
    const address = hostname.slice(1, -1);
    if (address === '::1' || address === '::') {
        return true; // loopback / unspecified
    }
    if (address.startsWith('::ffff:')) {
        // IPv4-mapped (::ffff:0:0/96): check the embedded IPv4 address.
        const [highGroup, lowGroup, ...rest] = address.slice('::ffff:'.length).split(':');
        if (highGroup !== undefined && lowGroup !== undefined && rest.length === 0) {
            const high = Number.parseInt(highGroup, 16);
            const low = Number.parseInt(lowGroup, 16);
            if (Number.isFinite(high) && Number.isFinite(low)) {
                return isLocalIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
            }
        }
        return false;
    }
    const firstGroup = address.split(':', 1)[0] ?? '';
    if (firstGroup === '') {
        return false; // leading `::` compression — first hextet is zero
    }
    const hextet = Number.parseInt(firstGroup, 16);
    if (!Number.isFinite(hextet)) {
        return false;
    }
    return (
        (hextet & 0xfe_00) === 0xfc_00 || // unique-local (fc00::/7)
        (hextet & 0xff_c0) === 0xfe_80 // link-local (fe80::/10)
    );
}

/**
 * Whether a hostname is a loopback hostname or a loopback/private/link-local IP
 * LITERAL. DNS names (other than `localhost`) are never classified as local —
 * the policy deliberately performs no name resolution.
 */
function isLocalHost(hostname: string): boolean {
    if (isLoopbackHostname(hostname)) {
        return true;
    }
    const ipv4 = parseIpv4(hostname);
    if (ipv4) {
        return isLocalIpv4(ipv4);
    }
    return isLocalIpv6(hostname);
}

/** Loopback in the narrow RFC 8252 §7.3 sense used for the `http:` exemption. */
function isLoopbackTarget(hostname: string): boolean {
    if (isLoopbackHostname(hostname)) {
        return true;
    }
    const ipv4 = parseIpv4(hostname);
    if (ipv4) {
        return ipv4[0] === 127;
    }
    return hostname === '[::1]';
}

/**
 * Default URL policy for OAuth discovery flows: validates a discovery-derived URL
 * against the rules described in the module documentation and throws
 * {@linkcode DiscoveryUrlBlockedError} (with the full {@linkcode DiscoveryUrlContext}
 * and a reason naming the overriding option) when a rule is violated. Returns
 * normally when the URL is allowed.
 *
 * Exported so custom validation hooks can delegate to the default policy and then
 * layer their own trust rules on top.
 */
export function assertAllowedDiscoveryUrl(ctx: DiscoveryUrlContext, opts?: DiscoveryUrlPolicyOptions): void {
    const { url, producer } = ctx;

    // Rule 1 (structural): http(s) only, no credentials in the URL, and https
    // everywhere except loopback (the RFC 8252 §7.3 exemption behind
    // assertSecureTokenEndpoint, applied to the full loopback set).
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new DiscoveryUrlBlockedError(
            ctx,
            `scheme '${url.protocol}' is not allowed; discovery URLs must use https: (or http: to a loopback host)`
        );
    }
    if (url.username !== '' || url.password !== '') {
        throw new DiscoveryUrlBlockedError(ctx, 'discovery URLs must not carry userinfo credentials');
    }
    if (url.protocol === 'http:' && !isLoopbackTarget(url.hostname) && !opts?.allowHttpDiscovery) {
        throw new DiscoveryUrlBlockedError(
            ctx,
            'http: is only allowed for loopback hosts (RFC 8252 §7.3); use https:, or set allowHttpDiscovery to permit it'
        );
    }

    // Rule 2 (locality symmetry): a non-local producer must not steer discovery
    // toward loopback or private/link-local IP literals. DNS names are deliberately
    // not resolved, so authorization servers on private https DNS names pass.
    if (!opts?.allowPrivateAddressTargets && isLocalHost(url.hostname) && !isLocalHost(producer.url.hostname)) {
        const producerLabel = producer.kind === 'mcp-server' ? 'MCP server' : 'authorization server';
        throw new DiscoveryUrlBlockedError(
            ctx,
            `host '${url.hostname}' is a loopback or private address, but the ${producerLabel} '${producer.url.hostname}' is not local; ` +
                'set allowPrivateAddressTargets to permit it'
        );
    }

    // Rule 3 (resource metadata origin): RFC 9728 §3 derives the well-known
    // metadata URL from the resource identifier itself, so conformant
    // protected-resource metadata is always same-origin with the server.
    if (ctx.purpose === 'resource-metadata' && url.origin !== producer.url.origin && !opts?.allowCrossOriginResourceMetadata) {
        throw new DiscoveryUrlBlockedError(
            ctx,
            `protected-resource-metadata URL origin '${url.origin}' does not match the MCP server origin '${producer.url.origin}' ` +
                '(RFC 9728 §3); set allowCrossOriginResourceMetadata to permit it'
        );
    }

    // Rule 4 (issuer syntax): RFC 8414 §2 — an authorization server issuer
    // identifier has no query and no fragment components.
    if (ctx.purpose === 'authorization-server' && (url.search !== '' || url.hash !== '')) {
        throw new DiscoveryUrlBlockedError(
            ctx,
            'an authorization server issuer identifier must not have query or fragment components (RFC 8414 §2)'
        );
    }
}
