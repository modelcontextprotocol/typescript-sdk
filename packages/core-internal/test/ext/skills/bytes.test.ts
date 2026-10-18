import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, decodeUtf8Lossless, encodeBase64, encodeUtf8, sha256Digest } from '../../../src/ext/skills/bytes';

describe('bytes', () => {
    it('round-trips base64 for every byte value', () => {
        const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
        expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    });

    it('decodes UTF-8 losslessly, keeping a BOM, and rejects invalid UTF-8', () => {
        const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]);
        expect(decodeUtf8Lossless(withBom)).toBe('\uFEFFa');
        expect(encodeUtf8(decodeUtf8Lossless(withBom)!)).toEqual(withBom);
        expect(decodeUtf8Lossless(Uint8Array.from([0xff, 0xfe]))).toBeUndefined();
    });

    it('computes sha256 digests identical to node:crypto', async () => {
        const bytes = encodeUtf8('hello skills');
        expect(await sha256Digest(bytes)).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    });

    it('hashes only the bytes of a view, and a view over a SharedArrayBuffer', async () => {
        const expected = `sha256:${createHash('sha256').update('hello skills').digest('hex')}`;
        expect(await sha256Digest(encodeUtf8('xxhello skillsyy').subarray(2, -2))).toBe(expected);
        const shared = new Uint8Array(new SharedArrayBuffer(12));
        shared.set(encodeUtf8('hello skills'));
        expect(await sha256Digest(shared)).toBe(expected);
    });

    it('hashes an ArrayBuffer-backed input without copying it', async () => {
        const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
        try {
            const bytes = encodeUtf8('hello skills');
            await sha256Digest(bytes);
            expect((digest.mock.calls[0]![1] as ArrayBufferView).buffer).toBe(bytes.buffer);
        } finally {
            digest.mockRestore();
        }
    });
});
