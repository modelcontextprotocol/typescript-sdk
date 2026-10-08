import type { SkillResource } from './types';

const encoder = new TextEncoder();

/** The raw bytes of a file: UTF-8 for text. */
export function skillFileBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === 'string' ? encoder.encode(content) : content;
}

/** `sha256:{hex}` of raw bytes, the digest format of a `SkillResource`. */
export async function skillDigest(bytes: Uint8Array): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
    return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The `SkillResource` entry for a file: its URI, digest and size. */
export async function skillResourceOf(uri: string, content: string | Uint8Array): Promise<SkillResource> {
    const bytes = skillFileBytes(content);
    return { uri, digest: await skillDigest(bytes), size: bytes.byteLength };
}
