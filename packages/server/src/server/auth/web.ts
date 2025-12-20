import { MethodNotAllowedError } from '@modelcontextprotocol/core';

export type HeaderMap = Record<string, string>;

export type WebHandlerContext = {
    /**
     * Optional pre-parsed request body from an upstream framework.
     * If provided, handlers will use this instead of reading from the Request stream.
     */
    parsedBody?: unknown;
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
