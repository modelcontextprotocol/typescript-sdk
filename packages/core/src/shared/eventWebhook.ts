/**
 * Utilities for MCP Events webhook delivery — Standard Webhooks signature
 * generation/verification and SSRF-resistant callback URL validation.
 *
 * MCP webhook delivery is a profile of
 * [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
 * `webhook-id` / `webhook-timestamp` / `webhook-signature` headers, `v1,<base64>`
 * HMAC-SHA256 over `id.timestamp.body`, `whsec_<base64>` secrets, multi-signature
 * rotation. Off-the-shelf Standard Webhooks verifiers (e.g. Svix) work without
 * modification. The only MCP-specific addition is the `X-MCP-Subscription-Id`
 * header so the receiver can select the correct secret before parsing the body.
 *
 * @module eventWebhook
 */

import { WebhookSecretSchema } from '../types/schemas.js';

/**
 * Standard Webhooks `webhook-id` header — a unique identifier for the
 * delivery, used by receivers for deduplication. For event deliveries this is
 * the `eventId`; for control envelopes it is `msg_<type>_<random>`.
 */
export const WEBHOOK_ID_HEADER = 'webhook-id';

/**
 * Standard Webhooks `webhook-timestamp` header — Unix timestamp (seconds) at
 * which the delivery was generated. Each retry regenerates this.
 */
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';

/**
 * Standard Webhooks `webhook-signature` header — one or more space-delimited
 * `v1,<base64>` HMAC values during secret rotation.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/**
 * MCP-specific header carrying the subscription `id` so the receiver can
 * select the correct signing secret before parsing the body. Not part of
 * Standard Webhooks.
 */
export const WEBHOOK_SUBSCRIPTION_ID_HEADER = 'X-MCP-Subscription-Id';

/**
 * Maximum age (seconds) of a webhook delivery before it is rejected as a potential replay.
 */
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * Recommended cap on webhook body size. Servers SHOULD log and drop deliveries
 * whose serialised body exceeds this; receivers MAY return `413` for oversized
 * bodies, which servers treat as non-retryable.
 */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Decodes the base64 (standard alphabet) bytes following the `whsec_` prefix.
 * Throws on values that don't satisfy the Standard Webhooks symmetric secret
 * format (`whsec_` + base64 of 24–64 bytes).
 */
export function decodeWebhookSecret(secret: string): Uint8Array {
    const parsed = WebhookSecretSchema.safeParse(secret);
    if (!parsed.success) {
        throw new TypeError('Webhook secret must be `whsec_` followed by base64 of 24-64 bytes');
    }
    const encoded = secret.slice('whsec_'.length);
    const raw = atob(encoded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        // eslint-disable-next-line unicorn/prefer-code-point -- atob returns Latin-1, charCodeAt is correct here
        bytes[i] = raw.charCodeAt(i);
    }
    if (bytes.length < 24 || bytes.length > 64) {
        throw new TypeError('Webhook secret must decode to 24-64 bytes');
    }
    return bytes;
}

/**
 * Generates a fresh Standard Webhooks symmetric secret (`whsec_` + base64 of
 * 32 random bytes). Client SDKs SHOULD use this to supply `delivery.secret`
 * rather than encouraging hand-picked values.
 */
export function generateWebhookSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCodePoint(b);
    return `whsec_${btoa(s)}`;
}

/**
 * Computes the Standard Webhooks `v1,<base64>` HMAC-SHA256 signature for a
 * delivery.
 *
 * The HMAC covers `webhook-id + "." + webhook-timestamp + "." + body` where
 * `body` is the raw HTTP request body bytes exactly as sent/received. The HMAC
 * key is the base64-decoded bytes after the `whsec_` prefix.
 *
 * @param secret - The `whsec_...` secret. Validated and decoded internally.
 * @param msgId - Value to be sent as `webhook-id` (the `eventId`, or `msg_...` for control envelopes).
 * @param timestamp - Unix timestamp (seconds) to be sent as `webhook-timestamp`.
 * @param body - The raw JSON body string being POSTed.
 * @returns A single `v1,<base64>` token suitable for the `webhook-signature` header.
 */
export async function computeWebhookSignature(secret: string, msgId: string, timestamp: number, body: string): Promise<string> {
    const keyBytes = decodeWebhookSecret(secret);
    const message = new TextEncoder().encode(`${msgId}.${timestamp}.${body}`);
    // Some lib configs don't accept Uint8Array<ArrayBufferLike> as BufferSource;
    // produce an exact ArrayBuffer.
    const toBuf = (u8: Uint8Array): ArrayBuffer => {
        const out = new ArrayBuffer(u8.byteLength);
        new Uint8Array(out).set(u8);
        return out;
    };
    const key = await crypto.subtle.importKey('raw', toBuf(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, toBuf(message)));
    let s = '';
    for (const b of mac) s += String.fromCodePoint(b);
    return `v1,${btoa(s)}`;
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
    }
    return result === 0;
}

/**
 * Verifies a Standard Webhooks delivery's HMAC signature(s) and timestamp
 * freshness.
 *
 * The signature header MAY contain multiple space-delimited `v1,<base64>`
 * tokens during secret rotation; the delivery is accepted if any verifies.
 *
 * @param secret - The `whsec_...` secret.
 * @param body - The raw request body as received (do NOT re-serialise).
 * @param idHeader - Value of the `webhook-id` header.
 * @param timestampHeader - Value of the `webhook-timestamp` header.
 * @param signatureHeader - Value of the `webhook-signature` header.
 * @param toleranceSeconds - Maximum allowed age of the delivery. Defaults to 5 minutes.
 */
export async function verifyWebhookSignature(
    secret: string,
    body: string,
    idHeader: string | null,
    timestampHeader: string | null,
    signatureHeader: string | null,
    toleranceSeconds: number = DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
): Promise<{ valid: boolean; reason?: string }> {
    if (!idHeader) return { valid: false, reason: 'Missing webhook-id header' };
    if (!timestampHeader) return { valid: false, reason: 'Missing webhook-timestamp header' };
    if (!signatureHeader) return { valid: false, reason: 'Missing webhook-signature header' };

    const timestamp = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(timestamp)) {
        return { valid: false, reason: 'Invalid webhook-timestamp header' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
        return { valid: false, reason: 'Timestamp outside tolerance window (possible replay)' };
    }

    const expected = await computeWebhookSignature(secret, idHeader, timestamp, body);
    for (const candidate of signatureHeader.split(' ')) {
        if (candidate.startsWith('v1,') && timingSafeEqual(candidate, expected)) {
            return { valid: true };
        }
    }
    return { valid: false, reason: 'Signature mismatch' };
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
 * Tests whether a normalised host string (IP literal or `localhost`) falls in
 * a private, loopback, or link-local range. The input MUST already have been
 * passed through {@linkcode normaliseHostname}.
 */
export function isPrivateAddress(normalisedHost: string): boolean {
    for (const pattern of PRIVATE_HOST_PATTERNS) {
        if (pattern.test(normalisedHost)) return true;
    }
    return false;
}

/**
 * Normalises a URL hostname for pattern matching: lowercases, strips IPv6
 * brackets, and unwraps IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`)
 * into the embedded IPv4 dotted form.
 */
export function normaliseHostname(hostname: string): string {
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

    if (!options.allowPrivateNetworks && isPrivateAddress(hostname)) {
        return { safe: false, reason: `Host ${rawHostname} resolves to a private or loopback range` };
    }

    return { safe: true };
}
