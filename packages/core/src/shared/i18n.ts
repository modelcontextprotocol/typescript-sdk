/**
 * Internationalization helpers for SEP-2792: Per-Request Language Negotiation.
 *
 * Provides constants and utilities for reading/writing language preference
 * metadata on MCP requests and responses, and for performing RFC 4647
 * language-range matching.
 *
 * @module i18n
 */

import { match } from '@formatjs/intl-localematcher';

/**
 * The `_meta` key for the client's language preference (request direction).
 * Value syntax matches the HTTP `Accept-Language` field (RFC 9110 §12.5.4).
 */
export const ACCEPT_LANGUAGE_META = 'io.modelcontextprotocol/acceptLanguage';

/**
 * The `_meta` key for the server's content language (response direction).
 * Value is a BCP 47 language tag (or comma-separated list per RFC 9110 §8.5).
 */
export const CONTENT_LANGUAGE_META = 'io.modelcontextprotocol/contentLanguage';

/**
 * Provisional JSON-RPC error code for HeaderMismatch per SEP-2792.
 * SEP-2243 originally proposed -32001, but a WG SDK survey showed
 * -32001 is already in conflicting use across SDKs (REQUEST_TIMEOUT
 * in Python/Kotlin, HeaderMismatch in Go/C#). The final code will
 * be assigned by SEP-2243/SEP-2678/PR #2642; this SDK will migrate
 * once they ratify.
 */
export const HEADER_MISMATCH_ERROR_CODE = -32_005;

/**
 * Reads the `acceptLanguage` value from request `params._meta`.
 */
export function getAcceptLanguage(params: { _meta?: Record<string, unknown> }): string | undefined {
    return params?._meta?.[ACCEPT_LANGUAGE_META] as string | undefined;
}

/**
 * Sets the `acceptLanguage` value on request `params._meta`.
 * Mutates the params object (creates `_meta` if absent).
 */
export function setAcceptLanguage(params: { _meta?: Record<string, unknown> }, value: string): void {
    if (!params._meta) {
        params._meta = {};
    }
    params._meta[ACCEPT_LANGUAGE_META] = value;
}

/**
 * Reads the `contentLanguage` value from a response result's `_meta`.
 */
export function getContentLanguage(result: { _meta?: Record<string, unknown> }): string | undefined {
    return result?._meta?.[CONTENT_LANGUAGE_META] as string | undefined;
}

/**
 * Sets the `contentLanguage` value on a response result's `_meta`.
 * Mutates the result object (creates `_meta` if absent).
 */
export function setContentLanguage(result: { _meta?: Record<string, unknown> }, value: string): void {
    if (!result._meta) {
        result._meta = {};
    }
    result._meta[CONTENT_LANGUAGE_META] = value;
}

/**
 * Reads `contentLanguage` from a JSON-RPC error's `data._meta`.
 * Per SEP-2792, localized error content uses `error.data._meta` since
 * the JSON-RPC Error object has no top-level `_meta`.
 */
export function getErrorContentLanguage(errorData: unknown): string | undefined {
    if (errorData && typeof errorData === 'object' && '_meta' in errorData) {
        const meta = (errorData as { _meta?: Record<string, unknown> })._meta;
        if (meta && typeof meta[CONTENT_LANGUAGE_META] === 'string') {
            return meta[CONTENT_LANGUAGE_META] as string;
        }
    }
    return undefined;
}

/**
 * Sets `contentLanguage` on a JSON-RPC error data object's `_meta`.
 * Mutates the data object (creates `_meta` if absent).
 * If `data` is not an object, wraps it: `{ originalData, _meta: {...} }`.
 *
 * Returns the (possibly new) data object to assign back to `error.data`.
 */
export function setErrorContentLanguage(data: unknown, value: string): Record<string, unknown> {
    let obj: Record<string, unknown>;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        obj = data as Record<string, unknown>;
    } else {
        obj = data === undefined ? {} : { originalData: data };
    }
    if (!obj._meta || typeof obj._meta !== 'object') {
        obj._meta = {};
    }
    (obj._meta as Record<string, unknown>)[CONTENT_LANGUAGE_META] = value;
    return obj;
}

/**
 * Parses an `Accept-Language` header value into an ordered list of locale tags.
 * Strips quality values and sorts by descending quality.
 */
function parseAcceptLanguage(acceptLanguage: string): string[] {
    const parsed = acceptLanguage
        .split(',')
        .map(part => {
            const [tag, ...params] = part.trim().split(';');
            const qParam = params.find(p => p.trim().startsWith('q='));
            const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
            return { tag: (tag ?? '').trim(), q };
        })
        .filter(({ tag }) => tag.length > 0 && tag !== '*');
    parsed.sort((a, b) => b.q - a.q);
    return parsed.map(({ tag }) => tag);
}

/**
 * Negotiates the best language from `available` given an `Accept-Language`
 * header value. Uses RFC 4647 "best fit" matching via `@formatjs/intl-localematcher`.
 *
 * @param acceptLanguage - An `Accept-Language` header value (e.g. `"fr-CA,fr;q=0.9,en;q=0.5"`)
 * @param available - Array of BCP 47 tags the server supports (e.g. `["en", "fr", "de"]`)
 * @param defaultLocale - Optional default locale if no match is found. If not provided, returns `undefined` on no match.
 * @returns The best matching locale from `available`, or `defaultLocale`, or `undefined`.
 */
export function negotiateLanguage(acceptLanguage: string, available: string[], defaultLocale?: string): string | undefined {
    if (!acceptLanguage || available.length === 0) {
        return defaultLocale;
    }

    const requested = parseAcceptLanguage(acceptLanguage);
    if (requested.length === 0) {
        return defaultLocale;
    }

    try {
        // @formatjs/intl-localematcher requires a defaultLocale; we use the first
        // available as a sentinel and check if the result is meaningful.
        const fallback = defaultLocale ?? available[0]!;
        const result = match(requested, available, fallback);
        // If no defaultLocale was provided and the result equals the sentinel,
        // verify the match is genuine (the requested list actually wanted it).
        if (!defaultLocale && result === available[0]) {
            // Check if any requested locale actually matches the first available
            const firstAvailable = available[0]!;
            const genuineMatch = requested.some(r => {
                const rLower = r.toLowerCase();
                const aLower = firstAvailable.toLowerCase();
                return aLower.startsWith(rLower) || rLower.startsWith(aLower) || rLower === aLower;
            });
            if (!genuineMatch) {
                return undefined;
            }
        }
        return result;
    } catch {
        return defaultLocale;
    }
}
