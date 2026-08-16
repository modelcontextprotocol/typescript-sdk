import contentType from 'content-type';

/**
 * Extracts the media type (the lowercased `type/subtype` pair, without
 * parameters) from a raw `Content-Type` header value, or `undefined` when the
 * header is missing or empty.
 *
 * Content-Type comparisons must use the parsed media type, never a substring
 * search of the raw header: a value like `text/plain; a=application/json`
 * contains the substring `application/json` but its media type is
 * `text/plain`, and case variants or parameters make naive string comparison
 * wrong in both directions.
 *
 * "Essence" is the WHATWG MIME Sniffing standard's term for the bare
 * `type/subtype` pair (https://mimesniff.spec.whatwg.org/#mime-type-essence);
 * the Fetch standard's request classification is defined against it
 * (https://fetch.spec.whatwg.org/#cors-safelisted-request-header).
 *
 * Parsing is RFC 9110 (`content-type` package) first. When the parameter
 * section is malformed (`application/json;`, `application/json; charset=`),
 * browsers and most HTTP stacks still derive the media type from the segment
 * before the first `;` — the fallback matches that widely-implemented
 * behavior, so a header whose media type is unambiguous is not rejected for
 * a sloppy parameter section.
 */
export function mediaTypeEssence(header: string | null | undefined): string | undefined {
    if (!header) {
        return undefined;
    }
    try {
        return contentType.parse(header).type;
    } catch {
        const essence = (header.split(';', 1)[0] ?? '').trim().toLowerCase();
        // A comma in the parameter tail of an unparseable value indicates
        // joined duplicate headers — ambiguous, so no essence at all (keeps
        // duplicate-header handling uniform whether or not the first copy
        // carries parameters).
        if (essence === '' || header.slice(essence.length).includes(',')) {
            return undefined;
        }
        return essence;
    }
}

/**
 * Whether a raw `Content-Type` header value denotes `application/json`.
 * Parameters (for example `charset=utf-8`) are allowed and ignored; malformed
 * parameter sections do not reject a header whose media type is unambiguously
 * `application/json` (see `mediaTypeEssence` for the exact grammar).
 */
export function isJsonContentType(header: string | null | undefined): boolean {
    // Fast path: the exact literal is what SDK clients send on every POST.
    if (header === 'application/json') {
        return true;
    }
    return mediaTypeEssence(header) === 'application/json';
}

/**
 * Parses an `Accept` header value into a set of media ranges (RFC 9110 §12.5.1).
 *
 * Each comma-separated range is lowercased and stripped of its parameters
 * (e.g. `;q=0.9`), so a value like `application/json; q=0.9` yields the range
 * `application/json`. Wildcards (the `*` forms) are kept as-is so callers
 * can honor the media-range matching rules of RFC 9110 §12.5.1 instead of
 * doing a substring search of the raw header — a substring search both lets
 * forged types through (`application/jsonx`) and rejects legal wildcards.
 */
export function parseAcceptRanges(header: string | null | undefined): Set<string> {
    const ranges = new Set<string>();
    if (!header) {
        return ranges;
    }
    for (const part of header.split(',')) {
        const range = part.split(';', 1)[0]?.trim().toLowerCase();
        if (range) {
            ranges.add(range);
        }
    }
    return ranges;
}

/**
 * Whether an `Accept` header value includes the given media type, following
 * the media-range matching rules of RFC 9110 §12.5.1: an exact `type/subtype`
 * range matches, and so do the `type/*` and `*` wildcard forms.
 */
export function acceptIncludes(header: string | null | undefined, type: string, subtype: string): boolean {
    const ranges = parseAcceptRanges(header);
    return ranges.has(`${type}/${subtype}`) || ranges.has(`${type}/*`) || ranges.has('*/*');
}
