/**
 * SEP-2792: Internationalization via Per-Request Language Negotiation.
 *
 * Constants, helpers, and matching utilities for the i18n `_meta` fields.
 * The mechanism is fully opt-in on both sides with no capability advertisement
 * required.
 *
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2792
 */
import { match } from '@formatjs/intl-localematcher';

// ---------------------------------------------------------------------------
// Meta-key constants (io.modelcontextprotocol vendor prefix per SEP-2133)
// ---------------------------------------------------------------------------

/**
 * Meta key for the client's language preference on any request/notification.
 * Value uses RFC 9110 `Accept-Language` grammar.
 */
export const ACCEPT_LANGUAGE_META = 'io.modelcontextprotocol/acceptLanguage';

/**
 * Meta key for the server's response language on results, `error.data._meta`,
 * and notification `params._meta`.
 */
export const CONTENT_LANGUAGE_META = 'io.modelcontextprotocol/contentLanguage';

// ---------------------------------------------------------------------------
// Request helpers (read/write acceptLanguage from params._meta)
// ---------------------------------------------------------------------------

/** Read `acceptLanguage` from `params._meta`. */
export function getAcceptLanguage(params: { _meta?: Record<string, unknown> } | undefined | null): string | undefined {
    const value = params?._meta?.[ACCEPT_LANGUAGE_META];
    return typeof value === 'string' ? value : undefined;
}

/** Set `acceptLanguage` on `params._meta`, creating `_meta` if needed. Returns mutated params. */
export function setAcceptLanguage<T extends { _meta?: Record<string, unknown> }>(params: T, value: string): T {
    if (params._meta === undefined) {
        (params as { _meta: Record<string, unknown> })._meta = {};
    }
    params._meta![ACCEPT_LANGUAGE_META] = value;
    return params;
}

// ---------------------------------------------------------------------------
// Response helpers (read/write contentLanguage from result._meta or error.data._meta)
// ---------------------------------------------------------------------------

/** Read `contentLanguage` from a result or `error.data` object's `_meta`. */
export function getContentLanguage(obj: { _meta?: Record<string, unknown> } | undefined | null): string | undefined {
    const value = obj?._meta?.[CONTENT_LANGUAGE_META];
    return typeof value === 'string' ? value : undefined;
}

/** Set `contentLanguage` on an object's `_meta`, creating `_meta` if needed. Returns mutated object. */
export function setContentLanguage<T extends { _meta?: Record<string, unknown> }>(obj: T, value: string): T {
    if (obj._meta === undefined) {
        (obj as { _meta: Record<string, unknown> })._meta = {};
    }
    obj._meta![CONTENT_LANGUAGE_META] = value;
    return obj;
}

// ---------------------------------------------------------------------------
// Language negotiation (thin wrapper around RFC 4647 matcher)
// ---------------------------------------------------------------------------

/**
 * Negotiate the best language from an `Accept-Language` value and a list of
 * available locales using RFC 4647 lookup matching.
 *
 * Returns the matched locale string from `available`, or `defaultLocale` if
 * no match is found. If `acceptLanguage` is malformed, returns `defaultLocale`
 * (MUST NOT error per SEP-2792).
 */
export function negotiateLanguage(acceptLanguage: string, available: readonly string[], defaultLocale: string): string {
    try {
        // Parse the Accept-Language value to extract requested locales (simple split).
        const requested = parseAcceptLanguageLocales(acceptLanguage);
        if (requested.length === 0) {
            return defaultLocale;
        }
        return match(requested, available as string[], defaultLocale);
    } catch {
        // Malformed values SHOULD behave as absent/default (SEP-2792 §4.2).
        return defaultLocale;
    }
}

/**
 * Extract locale tags from an Accept-Language header value, sorted by quality.
 * Returns an array of BCP 47 tags ordered by descending q-value.
 */
function parseAcceptLanguageLocales(header: string): string[] {
    const entries: Array<{ tag: string; q: number }> = [];
    for (const part of header.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const segments = trimmed.split(';');
        const tag = segments[0]?.trim() ?? '';
        let q = 1;
        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i];
            if (seg === undefined) continue;
            const qMatch = seg.trim().match(/^q\s*=\s*([0-9.]+)$/i);
            if (qMatch?.[1]) {
                q = Number.parseFloat(qMatch[1]);
                break;
            }
        }
        if (tag !== '' && tag !== '*') {
            entries.push({ tag, q });
        }
    }
    entries.sort((a, b) => b.q - a.q);
    return entries.map(e => e.tag);
}
