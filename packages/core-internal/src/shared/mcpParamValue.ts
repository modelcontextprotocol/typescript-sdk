// The header value encoding shared by the standard `Mcp-Name` header and the custom `Mcp-Param-*` headers.

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';
// RFC 4648 §4, padding required (the spec's encoding-examples table and the
// conformance referee's invalid-padding cell both require canonical padding).
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * `true` when `s` cannot be safely represented as a plain ASCII HTTP field
 * value per RFC 9110 §5.5: it contains a byte outside `0x20–0x7E` / `0x09`, it
 * has leading or trailing whitespace (which field parsing strips), or it
 * already matches the Base64 sentinel pattern (the spec's "to avoid ambiguity"
 * rule).
 */
function needsBase64(s: string): boolean {
    if (s.length === 0) return true;
    if (s.startsWith(BASE64_SENTINEL_PREFIX) && s.endsWith(BASE64_SENTINEL_SUFFIX)) return true;
    if (s !== s.trim()) return true;
    for (let i = 0; i < s.length; i++) {
        const c = s.codePointAt(i)!;
        // Visible ASCII 0x21–0x7E, plus space 0x20 and horizontal tab 0x09; a
        // tab is only safe when it is interior whitespace (the trim() check
        // above already covered leading/trailing).
        if (c === 0x09 || (c >= 0x20 && c <= 0x7e)) continue;
        return true;
    }
    return false;
}

function utf8ToBase64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCodePoint(b);
    return btoa(bin);
}

function base64ToUtf8(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i)!;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Encode a string value as an HTTP field value per the spec's value-encoding
 * rules: a value that is already a safe plain-ASCII field value is passed
 * through unchanged; anything else is wrapped as `=?base64?{b64-of-utf8}?=`.
 */
export function encodeMcpParamValue(value: string): string {
    return needsBase64(value) ? `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}` : value;
}

/**
 * Decode a header value: when it carries the Base64 sentinel,
 * the payload is decoded as UTF-8; otherwise the value is returned as-is.
 * Returns `undefined` when the sentinel is present but the payload is not
 * canonical Base64 (or not valid UTF-8) — the spec requires servers to reject
 * such values.
 */
export function decodeMcpParamValue(value: string): string | undefined {
    if (!(value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX))) {
        return value;
    }
    const b64 = value.slice(BASE64_SENTINEL_PREFIX.length, value.length - BASE64_SENTINEL_SUFFIX.length);
    if (!BASE64_CANONICAL.test(b64)) return undefined;
    try {
        return base64ToUtf8(b64);
    } catch {
        return undefined;
    }
}
