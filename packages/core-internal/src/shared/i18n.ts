/**
 * SEP-2792 per-request natural-language negotiation.
 *
 * This module carries language preference only. It does not infer timezone,
 * currency, formatting, collation, units, or any other locale behavior.
 *
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2792
 */
import type { JSONRPCMessage } from '../types/types';

/** Request `params._meta` key whose value uses RFC 9110 `Accept-Language` syntax. */
export const ACCEPT_LANGUAGE_META = 'io.modelcontextprotocol/acceptLanguage';

/** Result/error/notification `_meta` key whose value uses `Content-Language` syntax. */
export const CONTENT_LANGUAGE_META = 'io.modelcontextprotocol/contentLanguage';

type MetaCarrier = { _meta?: Record<string, unknown> };

interface WeightedLanguageRange {
    range: string;
    quality: number;
    position: number;
}

const LANGUAGE_RANGE = /^(?:\*|[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/;
const QUALITY_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

function trimOws(value: string): string {
    let start = 0;
    while (start < value.length && (value.codePointAt(start) === 0x20 || value.codePointAt(start) === 0x09)) start++;
    let end = value.length;
    while (end > start && (value.codePointAt(end - 1) === 0x20 || value.codePointAt(end - 1) === 0x09)) end--;
    return value.slice(start, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureMeta(carrier: MetaCarrier): Record<string, unknown> {
    if (carrier._meta === undefined) {
        carrier._meta = {};
    }
    return carrier._meta;
}

function parseAcceptLanguage(value: string): WeightedLanguageRange[] | undefined {
    // Fetch strips field-line OWS when setting the HTTP mirror. Reject it on
    // the canonical value so SDK-authored `_meta` stays byte-identical to what
    // the transport can emit.
    if (value.length === 0 || trimOws(value) !== value) return undefined;

    const ranges: WeightedLanguageRange[] = [];
    for (const [position, rawMember] of value.split(',').entries()) {
        const member = trimOws(rawMember);
        if (member.length === 0) return undefined;

        const segments = member.split(';');
        if (segments.length > 2) return undefined;
        const range = segments[0] === undefined ? undefined : trimOws(segments[0]);
        if (range === undefined || !LANGUAGE_RANGE.test(range)) return undefined;

        let quality = 1;
        const rawWeight = segments[1] === undefined ? undefined : trimOws(segments[1]);
        if (rawWeight !== undefined) {
            const match = /^q=(.*)$/i.exec(rawWeight);
            const qvalue = match?.[1];
            if (qvalue === undefined || !QUALITY_VALUE.test(qvalue)) return undefined;
            quality = Number(qvalue);
        }
        ranges.push({ range, quality, position });
    }

    return ranges.toSorted((left, right) => right.quality - left.quality || left.position - right.position);
}

function basicRangeMatches(range: string, tag: string): boolean {
    if (range === '*') return true;
    const normalizedRange = range.toLowerCase();
    const normalizedTag = tag.toLowerCase();
    return normalizedTag === normalizedRange || normalizedTag.startsWith(`${normalizedRange}-`);
}

function truncateLookupRange(range: string): string | undefined {
    const separator = range.lastIndexOf('-');
    if (separator === -1) return undefined;

    let truncated = range.slice(0, separator);
    const trailingSeparator = truncated.lastIndexOf('-');
    const trailingSubtag = truncated.slice(trailingSeparator + 1);
    if (trailingSubtag.length === 1) {
        truncated = trailingSeparator < 0 ? '' : truncated.slice(0, trailingSeparator);
    }
    return truncated.length === 0 ? undefined : truncated;
}

function rangeSpecificity(range: string): number {
    return range === '*' ? 0 : range.split('-').length;
}

function lookupSpecificity(range: string, language: string): number | undefined {
    if (range === '*') return 0;
    let candidate: string | undefined = range;
    while (candidate !== undefined) {
        if (basicRangeMatches(candidate, language)) return rangeSpecificity(candidate);
        candidate = truncateLookupRange(candidate);
    }
    return undefined;
}

interface LanguageCandidate {
    language: string;
    quality: number;
    position: number;
    availablePosition: number;
}

type ResolvedRange = WeightedLanguageRange & { specificity: number };

function preferredRange(current: ResolvedRange | undefined, candidate: ResolvedRange): ResolvedRange {
    if (current === undefined || candidate.specificity > current.specificity) return candidate;
    if (candidate.specificity < current.specificity) return current;
    if (candidate.quality === 0 && current.quality !== 0) return candidate;
    if (current.quality === 0 && candidate.quality !== 0) return current;
    if (candidate.quality > current.quality) return candidate;
    if (candidate.quality < current.quality) return current;
    return candidate.position < current.position ? candidate : current;
}

function candidateForLanguage(
    language: string,
    availablePosition: number,
    ranges: readonly WeightedLanguageRange[]
): LanguageCandidate | undefined {
    // RFC 9110 quality assignment uses the most specific range that directly
    // prefix-matches the available tag. Lookup truncation is a separate
    // positive-selection fallback and must never broaden a q=0 exclusion.
    let direct: ResolvedRange | undefined;
    for (const range of ranges) {
        if (!basicRangeMatches(range.range, language)) continue;
        direct = preferredRange(direct, { ...range, specificity: rangeSpecificity(range.range) });
    }

    let fallback: ResolvedRange | undefined;
    for (const range of ranges) {
        if (range.quality === 0 || range.range === '*') continue;
        const specificity = lookupSpecificity(range.range, language);
        if (specificity === undefined) continue;
        fallback = preferredRange(fallback, { ...range, specificity });
    }

    const selected =
        direct === undefined || (direct.specificity === 0 && fallback !== undefined && fallback.specificity > 0)
            ? (fallback ?? direct)
            : direct;
    return selected === undefined ? undefined : { language, quality: selected.quality, position: selected.position, availablePosition };
}

/** Return the decoded canonical field value without grammar validation. */
export function getRawAcceptLanguage(params: MetaCarrier | undefined | null): string | undefined {
    const value = params?._meta?.[ACCEPT_LANGUAGE_META];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Return a valid canonical language preference.
 *
 * Agreement checks must use {@linkcode getRawAcceptLanguage} first. Once
 * agreement has passed, this helper implements the receiver rule that a
 * malformed canonical value is treated as an absent preference without error.
 */
export function getAcceptLanguage(params: MetaCarrier | undefined | null): string | undefined {
    const value = getRawAcceptLanguage(params);
    return value !== undefined && isValidAcceptLanguage(value) ? value : undefined;
}

/**
 * Set a request's canonical language preference.
 *
 * The dedicated setter rejects malformed values so SDK-authored preferences
 * always satisfy the HTTP `Accept-Language` field-value grammar.
 */
export function setAcceptLanguage<T extends MetaCarrier>(params: T, value: string): T {
    if (!isValidAcceptLanguage(value)) {
        throw new TypeError('acceptLanguage must use RFC 9110 Accept-Language field-value syntax');
    }
    ensureMeta(params)[ACCEPT_LANGUAGE_META] = value;
    return params;
}

/** Return a result, error-data object, or notification's reported language. */
export function getContentLanguage(carrier: MetaCarrier | undefined | null): string | undefined {
    const value = carrier?._meta?.[CONTENT_LANGUAGE_META];
    return typeof value === 'string' ? value : undefined;
}

/** Set the reported language on a result, error-data object, or notification. */
export function setContentLanguage<T extends MetaCarrier>(carrier: T, value: string): T {
    ensureMeta(carrier)[CONTENT_LANGUAGE_META] = value;
    return carrier;
}

/**
 * Return `contentLanguage` from `error.data._meta`.
 *
 * Primitive and array `error.data` values cannot structurally carry `_meta`
 * and are deliberately ignored rather than wrapped into a new error shape.
 */
export function getErrorContentLanguage(data: unknown): string | undefined {
    return isRecord(data) ? getContentLanguage(data) : undefined;
}

/** Set `contentLanguage` on an object that is already valid JSON-RPC error data. */
export function setErrorContentLanguage<T extends Record<string, unknown>>(data: T, value: string): T {
    return setContentLanguage(data, value);
}

/** Return a result/error/notification message's canonical reported language. */
export function getMessageContentLanguage(message: JSONRPCMessage): string | undefined {
    if ('result' in message) return getContentLanguage(message.result);
    if ('error' in message) return getErrorContentLanguage(message.error.data);
    if ('method' in message) return getContentLanguage(message.params);
    return undefined;
}

/** Whether a value conforms to RFC 9110 `Accept-Language` field-value syntax. */
export function isValidAcceptLanguage(value: string): boolean {
    return parseAcceptLanguage(value) !== undefined;
}

/**
 * Test the Streamable HTTP mirror contract.
 *
 * Missing mirrors are tolerated because `_meta` is canonical. When both are
 * present, comparison is exact character-for-character equality after the HTTP
 * implementation has exposed the combined field value; no case, whitespace,
 * range-order, or quality-value normalization is applied.
 */
export function languageHeaderValueConflicts(headerValue: string | null | undefined, canonicalValue: string | undefined): boolean {
    return headerValue !== null && headerValue !== undefined && canonicalValue !== undefined && headerValue !== canonicalValue;
}

/**
 * Select an available natural language with weighted, case-insensitive RFC
 * 4647 lookup and wildcard handling.
 *
 * Malformed or absent preferences, and preferences with no supported match,
 * resolve to the server-defined default without error.
 */
export function negotiateLanguage(acceptLanguage: string | undefined, available: readonly string[], defaultLanguage: string): string {
    if (acceptLanguage === undefined) return defaultLanguage;
    const ranges = parseAcceptLanguage(acceptLanguage);
    if (ranges === undefined) return defaultLanguage;

    const candidates = available
        .map((language, position) => candidateForLanguage(language, position, ranges))
        .filter((candidate): candidate is LanguageCandidate => candidate !== undefined && candidate.quality > 0)
        .toSorted(
            (left, right) =>
                right.quality - left.quality ||
                left.position - right.position ||
                Number(right.language.toLowerCase() === defaultLanguage.toLowerCase()) -
                    Number(left.language.toLowerCase() === defaultLanguage.toLowerCase()) ||
                left.availablePosition - right.availablePosition
        );
    return candidates[0]?.language ?? defaultLanguage;
}
