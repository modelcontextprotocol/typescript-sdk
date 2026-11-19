const encoder = new TextEncoder();

/** UTF-8 bytes of `text`. */
export function encodeUtf8(text: string): Uint8Array {
    return encoder.encode(text);
}

/** Decodes UTF-8 only if decoding loses nothing (a BOM is kept); otherwise `undefined`. */
export function decodeUtf8Lossless(bytes: Uint8Array): string | undefined {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

/** Standard base64 of `bytes`. */
export function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x80_00;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCodePoint(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
}

/** Bytes of a standard base64 string. */
export function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.codePointAt(index)!;
    return bytes;
}

/** `sha256:` followed by the lowercase hex SHA-256 of `bytes` (WebCrypto, every runtime). */
export async function sha256Digest(bytes: Uint8Array): Promise<string> {
    const { buffer, byteOffset, byteLength } = bytes;
    // WebCrypto refuses views over a SharedArrayBuffer; only those are copied.
    const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer, byteOffset, byteLength) : new Uint8Array(bytes);
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', view));
    let hex = '';
    for (const byte of hash) hex += byte.toString(16).padStart(2, '0');
    return `sha256:${hex}`;
}
