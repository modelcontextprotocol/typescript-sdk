import type { JSONRPCRequest } from '../types/index.js';

/**
 * SEP-2243: Methods whose `Mcp-Name` header mirrors a request body field, and which field.
 * Exposed so the client transport (sets headers) and server transports (validate them)
 * agree on the source field.
 */
const NAME_FIELD_FOR: Record<string, 'name' | 'uri'> = {
    'tools/call': 'name',
    'prompts/get': 'name',
    'resources/read': 'uri'
};

/**
 * Returns the SEP-2243 `Mcp-Name` value for a request body, or `undefined` if the method
 * has no name-level field.
 */
export function mcpNameForMethod(method: string, params: unknown): string | undefined {
    const field = NAME_FIELD_FOR[method];
    if (!field || !params || typeof params !== 'object') return undefined;
    const v = (params as Record<string, unknown>)[field];
    return typeof v === 'string' ? v : undefined;
}

// HTTP header values must be ISO-8859-1. SEP-2243 specifies RFC-2047-style encoding
// (`=?base64?<b64>?=`) for values containing characters outside the safe-header range.
const HEADER_SAFE = /^[ -~]*$/;

/** Encode a value for use as an `Mcp-*` HTTP header per SEP-2243 (RFC-2047 base64 for non-ASCII). */
export function encodeMcpHeaderValue(value: string): string {
    if (HEADER_SAFE.test(value)) return value;
    // Byte-level mapping for btoa: each Uint8 byte must become one Latin-1 char.
    // eslint-disable-next-line unicorn/prefer-code-point
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    return `=?base64?${b64}?=`;
}

/** Decode an `Mcp-*` HTTP header value, reversing {@linkcode encodeMcpHeaderValue}. */
export function decodeMcpHeaderValue(value: string): string {
    const m = /^=\?base64\?(.+)\?=$/.exec(value);
    if (!m) return value;
    // atob output is one Latin-1 char per byte; charCodeAt gives the byte value back.
    // eslint-disable-next-line unicorn/prefer-code-point
    const bytes = Uint8Array.from(atob(m[1]!), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/**
 * SEP-2243 server-side enforcement: returns a header-mismatch error message if the supplied
 * `Mcp-Method` / `Mcp-Name` headers do not match the body, or `undefined` if they match
 * (or are absent). Per the spec, headers are required for compliance with the version they
 * are introduced in; this validator only rejects on PRESENT-but-mismatched, since absence
 * may indicate a pre-SEP-2243 client. Batch bodies are not validated (no single method).
 */
export function validateMcpHeaders(httpReq: Request, body: JSONRPCRequest | JSONRPCRequest[]): string | undefined {
    if (Array.isArray(body)) return undefined;
    const hMethodRaw = httpReq.headers.get('mcp-method');
    const hMethod = hMethodRaw === null ? null : decodeMcpHeaderValue(hMethodRaw);
    if (hMethod !== null && hMethod !== body.method) {
        return `Mcp-Method header '${hMethod}' does not match request body method '${body.method}'`;
    }
    const hNameRaw = httpReq.headers.get('mcp-name');
    if (hNameRaw !== null) {
        const hName = decodeMcpHeaderValue(hNameRaw);
        const bodyName = mcpNameForMethod(body.method, body.params);
        if (hName !== bodyName) {
            return `Mcp-Name header '${hName}' does not match request body ${NAME_FIELD_FOR[body.method] ?? 'name'} '${bodyName ?? '(absent)'}'`;
        }
    }
    return undefined;
}
