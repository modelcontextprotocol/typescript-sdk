/**
 * Utilities for MCP Events webhook delivery — HMAC signature generation/verification
 * and SSRF-resistant callback URL validation.
 *
 * @module eventWebhook
 */

/**
 * Header carrying the HMAC-SHA256 signature of a webhook delivery.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-MCP-Signature';

/**
 * Header carrying the Unix timestamp (seconds) at which the delivery was generated.
 */
export const WEBHOOK_TIMESTAMP_HEADER = 'X-MCP-Timestamp';

/**
 * Maximum age (seconds) of a webhook delivery before it is rejected as a potential replay.
 */
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Computes the HMAC-SHA256 signature for a webhook delivery body.
 *
 * The signature covers `timestamp + "." + body` to prevent replay attacks —
 * a captured payload cannot be replayed after the timestamp tolerance window.
 *
 * @param secret - Shared secret established at subscribe time.
 * @param timestamp - Unix timestamp (seconds) at which the delivery is being generated.
 * @param body - The raw JSON body string being POSTed.
 * @returns The hex-encoded HMAC-SHA256 digest, prefixed with `sha256=`.
 */
export async function computeWebhookSignature(secret: string, timestamp: number, body: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const message = encoder.encode(`${timestamp}.${body}`);

    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, message);
    const hex = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `sha256=${hex}`;
}

/**
 * Constant-time string comparison to prevent timing attacks on signature verification.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
    }
    return result === 0;
}

/**
 * Verifies a webhook delivery's HMAC signature and timestamp freshness.
 *
 * @param secret - Shared secret established at subscribe time.
 * @param body - The raw request body as received (do NOT re-serialize).
 * @param signatureHeader - Value of the `X-MCP-Signature` header.
 * @param timestampHeader - Value of the `X-MCP-Timestamp` header (Unix seconds as string).
 * @param toleranceSeconds - Maximum allowed age of the delivery. Defaults to 5 minutes.
 * @returns An object describing whether the signature is valid and why.
 */
export async function verifyWebhookSignature(
    secret: string,
    body: string,
    signatureHeader: string | null,
    timestampHeader: string | null,
    toleranceSeconds: number = DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
): Promise<{ valid: boolean; reason?: string }> {
    if (!signatureHeader) {
        return { valid: false, reason: 'Missing signature header' };
    }
    if (!timestampHeader) {
        return { valid: false, reason: 'Missing timestamp header' };
    }

    const timestamp = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(timestamp)) {
        return { valid: false, reason: 'Invalid timestamp header' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
        return { valid: false, reason: 'Timestamp outside tolerance window (possible replay)' };
    }

    const expected = await computeWebhookSignature(secret, timestamp, body);
    if (!timingSafeEqual(expected, signatureHeader)) {
        return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
}

/**
 * Options for {@linkcode isSafeWebhookUrl}.
 */
export interface WebhookUrlValidationOptions {
    /**
     * If `true`, allows `http://` URLs (not recommended in production).
     * Defaults to `false`.
     */
    allowInsecure?: boolean;
    /**
     * If `true`, allows loopback and private-range hosts.
     * Defaults to `false`.
     */
    allowPrivateNetworks?: boolean;
    /**
     * Optional allowlist of hostnames. If provided, only URLs whose hostname
     * appears in this list (exact match) are accepted.
     */
    allowedHosts?: string[];
}

/**
 * RFC 1918 private ranges, loopback, and link-local prefixes that webhook URLs
 * should not target unless explicitly allowed. This is a best-effort hostname
 * check — for DNS-rebinding resistance, the server SHOULD also validate the
 * resolved IP at delivery time.
 *
 * Patterns are matched against a normalised hostname (lowercased, brackets
 * stripped, IPv4-mapped-IPv6 unwrapped).
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
    /^localhost$/,
    /^127\./,
    /^0\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::$/,
    /^::1$/,
    /^(0+:){7}0*1$/,
    /^fc[\da-f]{2}:/,
    /^fd[\da-f]{2}:/,
    /^fe80:/
];

/**
 * Normalises a URL hostname for pattern matching: lowercases, strips IPv6
 * brackets, and unwraps IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`)
 * into the embedded IPv4 dotted form.
 */
function normaliseHostname(hostname: string): string {
    let h = hostname.toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) {
        h = h.slice(1, -1);
    }
    // IPv4-mapped IPv6 — dotted form (::ffff:127.0.0.1).
    const dottedMapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (dottedMapped) {
        return dottedMapped[1]!;
    }
    // IPv4-mapped IPv6 — hex form (::ffff:7f00:1 → 127.0.0.1).
    const hexMapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(h);
    if (hexMapped) {
        const hi = Number.parseInt(hexMapped[1]!, 16);
        const lo = Number.parseInt(hexMapped[2]!, 16);
        return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return h;
}

/**
 * Validates a webhook callback URL for basic SSRF safety and scheme hygiene.
 *
 * This is a **subscribe-time** check — it inspects the URL string. Servers
 * that need defence against DNS rebinding SHOULD additionally resolve the
 * hostname at delivery time and re-validate the IP.
 *
 * @param url - The callback URL string from `events/subscribe`.
 * @param options - Validation options.
 * @returns `{ safe: true }` or `{ safe: false, reason }`.
 */
export function isSafeWebhookUrl(url: string, options: WebhookUrlValidationOptions = {}): { safe: boolean; reason?: string } {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { safe: false, reason: 'Invalid URL' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { safe: false, reason: `Unsupported scheme: ${parsed.protocol}` };
    }

    if (parsed.protocol === 'http:' && !options.allowInsecure) {
        return { safe: false, reason: 'Plain HTTP is not allowed; use https:// or set allowInsecure' };
    }

    const rawHostname = parsed.hostname;
    const hostname = normaliseHostname(rawHostname);

    if (options.allowedHosts && options.allowedHosts.length > 0) {
        if (!options.allowedHosts.includes(rawHostname) && !options.allowedHosts.includes(hostname)) {
            return { safe: false, reason: `Host ${rawHostname} is not in the allowlist` };
        }
        return { safe: true };
    }

    if (!options.allowPrivateNetworks) {
        for (const pattern of PRIVATE_HOST_PATTERNS) {
            if (pattern.test(hostname)) {
                return { safe: false, reason: `Host ${rawHostname} resolves to a private or loopback range` };
            }
        }
    }

    return { safe: true };
}
