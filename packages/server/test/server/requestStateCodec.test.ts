/**
 * `createRequestStateCodec` — the opt-in HMAC-SHA256 sealing helper for the
 * multi-round-trip `requestState` (SEP-2322). Pure unit tests of the codec;
 * the seam-level wiring (`ServerOptions.requestState.verify`) is covered in
 * `inputRequired.test.ts`.
 */
import type { ServerContext } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { createRequestStateCodec } from '../../src/server/requestStateCodec.js';
import type { ServerOptions } from '../../src/server/server.js';

const KEY = crypto.getRandomValues(new Uint8Array(32));

// Minimal stand-in for the bits of ServerContext the codec's `bind` callback
// reads — the codec itself never inspects ctx beyond passing it to `bind`.
const fakeCtx = (method: string, clientId?: string) =>
    ({ mcpReq: { method }, http: clientId === undefined ? undefined : { authInfo: { clientId } } }) as unknown as ServerContext;

describe('createRequestStateCodec', () => {
    it('round-trips a JSON payload', async () => {
        const codec = createRequestStateCodec<{ step: string; n: number }>({ key: KEY });
        const wire = await codec.mint({ step: 'confirm', n: 42 });
        expect(wire).toMatch(/^v1\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/);
        const payload = await codec.verify(wire, fakeCtx('tools/call'));
        expect(payload).toEqual({ step: 'confirm', n: 42 });
    });

    it('rejects a tampered body with reason "mac"', async () => {
        const codec = createRequestStateCodec({ key: KEY });
        const wire = await codec.mint({ step: 'confirm' });
        // Flip a base64url character in the body segment.
        const dot = wire.lastIndexOf('.');
        const tampered = `${wire.slice(0, 4)}${wire[4] === 'A' ? 'B' : 'A'}${wire.slice(5, dot)}${wire.slice(dot)}`;
        await expect(codec.verify(tampered, fakeCtx('tools/call'))).rejects.toThrow('mac');
    });

    it('rejects a tampered MAC with reason "mac"', async () => {
        const codec = createRequestStateCodec({ key: KEY });
        const wire = await codec.mint({ step: 'confirm' });
        const tampered = `${wire.slice(0, -2)}${wire.at(-2) === 'A' ? 'B' : 'A'}${wire.at(-1)}`;
        await expect(codec.verify(tampered, fakeCtx('tools/call'))).rejects.toThrow('mac');
    });

    it('rejects values minted under a different key', async () => {
        const codecA = createRequestStateCodec({ key: KEY });
        const codecB = createRequestStateCodec({ key: crypto.getRandomValues(new Uint8Array(32)) });
        const wire = await codecA.mint({ step: 'confirm' });
        await expect(codecB.verify(wire, fakeCtx('tools/call'))).rejects.toThrow('mac');
    });

    it('rejects malformed envelopes (missing prefix / missing segments)', async () => {
        const codec = createRequestStateCodec({ key: KEY });
        await expect(codec.verify('not-v1.body.mac', fakeCtx('tools/call'))).rejects.toThrow('malformed');
        await expect(codec.verify('v1.bodyonly', fakeCtx('tools/call'))).rejects.toThrow('malformed');
        await expect(codec.verify('v1..mac', fakeCtx('tools/call'))).rejects.toThrow('malformed');
        await expect(codec.verify('', fakeCtx('tools/call'))).rejects.toThrow('malformed');
    });

    it('rejects an expired value with reason "expired"', async () => {
        // ttlSeconds: -1 stamps an exp already in the past; the MAC still
        // verifies (we minted it), so the rejection is the expiry check.
        const codec = createRequestStateCodec({ key: KEY, ttlSeconds: -1 });
        const wire = await codec.mint({ step: 'confirm' });
        await expect(codec.verify(wire, fakeCtx('tools/call'))).rejects.toThrow('expired');
    });

    describe('context binding', () => {
        const bind = (ctx: ServerContext) =>
            `${ctx.mcpReq.method}\0${(ctx.http?.authInfo as { clientId?: string } | undefined)?.clientId ?? ''}`;

        it('round-trips when the binding value matches', async () => {
            const codec = createRequestStateCodec<{ step: string }>({ key: KEY, bind });
            const wire = await codec.mint({ step: 'confirm' }, fakeCtx('tools/call', 'alice'));
            const payload = await codec.verify(wire, fakeCtx('tools/call', 'alice'));
            expect(payload).toEqual({ step: 'confirm' });
        });

        it('rejects with reason "bind" when the binding value differs — message is opaque', async () => {
            const codec = createRequestStateCodec({ key: KEY, bind });
            const wire = await codec.mint({ step: 'confirm' }, fakeCtx('tools/call', 'alice'));
            const rejection = await codec.verify(wire, fakeCtx('tools/call', 'mallory')).catch((e: Error) => e);
            expect(rejection).toBeInstanceOf(Error);
            // The thrown reason is a fixed code; neither principal identifier
            // appears in the message (so onerror logging cannot leak them).
            expect((rejection as Error).message).toBe('bind');
            expect((rejection as Error).message).not.toContain('alice');
            expect((rejection as Error).message).not.toContain('mallory');
        });

        it('mint without ctx throws when bind is configured', async () => {
            const codec = createRequestStateCodec({ key: KEY, bind });
            await expect(codec.mint({ step: 'confirm' })).rejects.toThrow(TypeError);
        });
    });

    it('throws RangeError on a key shorter than 32 bytes', () => {
        expect(() => createRequestStateCodec({ key: new Uint8Array(31) })).toThrow(RangeError);
        expect(() => createRequestStateCodec({ key: 'short' })).toThrow(RangeError);
    });

    it('accepts a 32-character string key (UTF-8 length)', async () => {
        const codec = createRequestStateCodec({ key: 'a'.repeat(32) });
        const wire = await codec.mint({ ok: true });
        expect(await codec.verify(wire, fakeCtx('tools/call'))).toEqual({ ok: true });
    });

    it('codec.verify is directly assignable to ServerOptions.requestState.verify', () => {
        // Type-level guard: the seam hook accepts any return so a verifier
        // that also yields the decoded payload drops in directly.
        const codec = createRequestStateCodec({ key: KEY });
        const opts: ServerOptions = { requestState: { verify: codec.verify } };
        expect(opts.requestState?.verify).toBe(codec.verify);
    });
});
