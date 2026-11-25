import type { WebhookControlBody } from '@modelcontextprotocol/core/ext/events';

const SECRET_PREFIX = 'whsec_';
const PADDED_BASE64 = /^(?:[\d+/A-Za-z]{4})*(?:[\d+/A-Za-z]{2}==|[\d+/A-Za-z]{3}=)?$/;
const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return btoa(binary);
}

function randomBytes(length: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function hmacSignatures(
    secrets: readonly Uint8Array[],
    webhookId: string,
    timestampSeconds: number,
    body: string
): Promise<string[]> {
    const content = encoder.encode(`${webhookId}.${timestampSeconds}.${body}`);
    return Promise.all(
        secrets.map(async secret => {
            // Copied so WebCrypto never sees a view over a SharedArrayBuffer.
            const key = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
                'sign'
            ]);
            return toBase64(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, content)));
        })
    );
}

// The bytes of a Standard Webhooks secret: `whsec_` and padded base64 of 24 to 64 bytes; otherwise `undefined`.
export function parseWebhookSecret(secret: string): Uint8Array | undefined {
    if (!secret.startsWith(SECRET_PREFIX)) return undefined;
    const encoded = secret.slice(SECRET_PREFIX.length);
    if (!PADDED_BASE64.test(encoded)) return undefined;
    const bytes = Uint8Array.from(atob(encoded), char => char.codePointAt(0)!);
    return bytes.length >= 24 && bytes.length <= 64 ? bytes : undefined;
}

// A new Standard Webhooks secret: `whsec_` and base64 of 32 random bytes.
export function generateWebhookSecret(): string {
    return `${SECRET_PREFIX}${toBase64(randomBytes(32))}`;
}

// A new `webhook-id`: `msg_` and base64url of 16 random bytes, or `msg_<type>_…` for a control body.
export function generateWebhookId(controlType?: WebhookControlBody['type']): string {
    const random = toBase64(randomBytes(16)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    return controlType === undefined ? `msg_${random}` : `msg_${controlType}_${random}`;
}

// The `webhook-signature` header: `v1,<base64 HMAC-SHA256 of id.timestamp.body>` per secret, space-separated.
export async function signWebhook(
    secrets: readonly Uint8Array[],
    webhookId: string,
    timestampSeconds: number,
    body: string
): Promise<string> {
    const signatures = await hmacSignatures(secrets, webhookId, timestampSeconds, body);
    return signatures.map(signature => `v1,${signature}`).join(' ');
}

// Whether any `v1,` entry of a `webhook-signature` header matches the raw body under any of the secrets.
export async function verifyWebhookSignature(
    secrets: readonly Uint8Array[],
    webhookId: string,
    timestampSeconds: number,
    rawBody: string,
    signatureHeader: string
): Promise<boolean> {
    const expected = await hmacSignatures(secrets, webhookId, timestampSeconds, rawBody);
    const received = signatureHeader
        .split(' ')
        .filter(entry => entry.startsWith('v1,'))
        .map(entry => entry.slice('v1,'.length));
    return received.some(signature => expected.some(candidate => timingSafeEqualString(signature, candidate)));
}

// Whether two strings are equal, in time that does not depend on where they differ.
export function timingSafeEqualString(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a.codePointAt(index)! ^ b.codePointAt(index)!;
    return difference === 0;
}
