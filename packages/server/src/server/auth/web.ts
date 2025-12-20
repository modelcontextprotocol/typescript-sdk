import { MethodNotAllowedError } from '@modelcontextprotocol/core';

export type HeaderMap = Record<string, string>;

export type WebHandlerContext = {
    /**
     * Optional pre-parsed request body from an upstream framework.
     * If provided, handlers will use this instead of reading from the Request stream.
     */
    parsedBody?: unknown;

    /**
     * Optional client address for rate limiting (e.g., IP).
     */
    clientAddress?: string;
};

export type WebHandler = (req: Request, ctx?: WebHandlerContext) => Promise<Response>;

export function jsonResponse(body: unknown, init?: { status?: number; headers?: HeaderMap }): Response {
    const headers: HeaderMap = { 'Content-Type': 'application/json' };
    if (init?.headers) {
        Object.assign(headers, init.headers);
    }
    return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers
    });
}

export function noStoreHeaders(): HeaderMap {
    return { 'Cache-Control': 'no-store' };
}

export function getClientAddress(req: Request, ctx?: WebHandlerContext): string | undefined {
    if (ctx?.clientAddress) return ctx.clientAddress;
    const xff = req.headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0]?.trim();
    return undefined;
}

export async function getParsedBody(req: Request, ctx?: WebHandlerContext): Promise<unknown> {
    if (ctx?.parsedBody !== undefined) {
        return ctx.parsedBody;
    }

    const ct = req.headers.get('content-type') ?? '';

    if (ct.includes('application/json')) {
        return await req.json();
    }

    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await req.text();
        return objectFromUrlEncoded(text);
    }

    // Empty bodies are treated as empty objects.
    const text = await req.text();
    if (!text) return {};

    // If content-type is missing/unknown, fall back to treating it as urlencoded-like.
    return objectFromUrlEncoded(text);
}

export function objectFromUrlEncoded(body: string): Record<string, string> {
    const params = new URLSearchParams(body);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
}

export function methodNotAllowedResponse(req: Request, allowed: string[]): Response {
    const error = new MethodNotAllowedError(`The method ${req.method} is not allowed for this endpoint`);
    return jsonResponse(error.toResponseObject(), {
        status: 405,
        headers: { Allow: allowed.join(', ') }
    });
}

export type CorsOptions = {
    allowOrigin?: string;
    allowMethods: readonly string[];
    allowHeaders?: readonly string[];
    exposeHeaders?: readonly string[];
    maxAgeSeconds?: number;
};

export function corsHeaders(options: CorsOptions): HeaderMap {
    return {
        'Access-Control-Allow-Origin': options.allowOrigin ?? '*',
        'Access-Control-Allow-Methods': options.allowMethods.join(', '),
        'Access-Control-Allow-Headers': (options.allowHeaders ?? ['Content-Type', 'Authorization']).join(', '),
        ...(options.exposeHeaders ? { 'Access-Control-Expose-Headers': options.exposeHeaders.join(', ') } : {}),
        ...(options.maxAgeSeconds !== undefined ? { 'Access-Control-Max-Age': String(options.maxAgeSeconds) } : {})
    };
}

export function corsPreflightResponse(options: CorsOptions): Response {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(options)
    });
}

export type InMemoryRateLimitConfig = {
    windowMs: number;
    max: number;
};

type RateState = { windowStart: number; count: number };

/**
 * Minimal in-memory rate limiter for single-process deployments.
 * Not suitable for distributed setups without an external store.
 */
export class InMemoryRateLimiter {
    private _state = new Map<string, RateState>();

    constructor(private _config: InMemoryRateLimitConfig) {}

    consume(key: string): { allowed: boolean; retryAfterSeconds?: number } {
        const now = Date.now();
        const windowStart = now - (now % this._config.windowMs);
        const existing = this._state.get(key);

        if (!existing || existing.windowStart !== windowStart) {
            this._state.set(key, { windowStart, count: 1 });
            return { allowed: true };
        }

        if (existing.count >= this._config.max) {
            const retryAfterMs = windowStart + this._config.windowMs - now;
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
        }

        existing.count += 1;
        return { allowed: true };
    }
}
