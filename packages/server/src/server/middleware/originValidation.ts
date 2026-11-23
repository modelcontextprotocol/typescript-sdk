/**
 * Framework-agnostic Origin header validation helpers.
 *
 * Browsers attach an `Origin` header to cross-origin requests; validating it
 * against an allowlist (alongside Host header validation) protects local and
 * development MCP servers against DNS rebinding and cross-site request
 * forgery. The framework middleware packages (`@modelcontextprotocol/express`,
 * `@modelcontextprotocol/hono`, `@modelcontextprotocol/fastify`,
 * `@modelcontextprotocol/node`) wrap these helpers; use them directly when
 * mounting a handler bare on a fetch-native runtime.
 *
 * Validation is deny-on-failure: a present `Origin` value that cannot be
 * parsed (including the opaque `null` origin) is rejected, never passed
 * through. Requests without an `Origin` header pass — non-browser MCP clients
 * do not send one.
 */

export type OriginValidationResult =
    | { ok: true; origin?: string; hostname?: string }
    | {
          ok: false;
          errorCode: 'invalid_origin_header' | 'invalid_origin';
          message: string;
          originHeader?: string;
          hostname?: string;
      };

/**
 * Validate an `Origin` header against an allowlist of hostnames (port-agnostic).
 *
 * - A missing/empty `Origin` header passes: non-browser clients do not send one,
 *   and only browser-originated requests carry the header this check defends against.
 * - Allowlist items are hostnames only (no scheme, no port), the same convention as
 *   `validateHostHeader`. For IPv6, include brackets (e.g. `[::1]`).
 * - A browser extension's origin carries its extension ID as the hostname; list the
 *   ID to allow one extension. An allowlist item of the form `<scheme>://*`
 *   (lowercase, e.g. `moz-extension://*`) allows every origin of that scheme, which
 *   Firefox needs because its extension IDs differ on every install.
 *   `http://*` and `https://*` are not honoured: list websites by hostname.
 * - Any present value that cannot be parsed as an origin URL — including the literal
 *   `null` origin browsers send for opaque contexts — is rejected (deny on failure).
 */
export function validateOriginHeader(originHeader: string | null | undefined, allowedOriginHostnames: string[]): OriginValidationResult {
    if (originHeader === null || originHeader === undefined || originHeader === '') {
        return { ok: true };
    }

    let hostname: string;
    let scheme: string;
    try {
        const url = new URL(originHeader);
        hostname = url.hostname;
        scheme = url.protocol;
    } catch {
        return { ok: false, errorCode: 'invalid_origin_header', message: `Invalid Origin header: ${originHeader}`, originHeader };
    }
    if (hostname === '') {
        // Opaque origins ("null") and other non-hierarchical values parse without a
        // hostname; they can never be allowlisted.
        return { ok: false, errorCode: 'invalid_origin_header', message: `Invalid Origin header: ${originHeader}`, originHeader };
    }

    const schemeAllowed = scheme !== 'http:' && scheme !== 'https:' && allowedOriginHostnames.includes(`${scheme}//*`);
    if (!schemeAllowed && !allowedOriginHostnames.includes(hostname)) {
        return { ok: false, errorCode: 'invalid_origin', message: `Invalid Origin: ${hostname}`, originHeader, hostname };
    }

    return { ok: true, origin: originHeader, hostname };
}

/**
 * Convenience allowlist of localhost-class origin hostnames, mirroring
 * `localhostAllowedHostnames`.
 */
export function localhostAllowedOrigins(): string[] {
    return ['localhost', '127.0.0.1', '[::1]'];
}

/**
 * Web-standard `Request` helper for Origin validation: returns a `403` JSON-RPC
 * error response when the request's `Origin` header is not allowed, and
 * `undefined` when the request may proceed.
 *
 * ```ts
 * const rejected = originValidationResponse(request, localhostAllowedOrigins());
 * if (rejected) return rejected;
 * ```
 */
export function originValidationResponse(req: Request, allowedOriginHostnames: string[]): Response | undefined {
    const result = validateOriginHeader(req.headers.get('origin'), allowedOriginHostnames);
    if (result.ok) return undefined;

    return Response.json(
        {
            jsonrpc: '2.0',
            error: {
                code: -32_000,
                message: result.message
            },
            id: null
        },
        {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}
