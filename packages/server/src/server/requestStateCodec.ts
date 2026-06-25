import type { ServerContext } from '@modelcontextprotocol/core-internal';

/**
 * Options for {@linkcode createRequestStateCodec}.
 */
export interface RequestStateCodecOptions {
    /**
     * The HMAC secret. A `string` value is UTF-8-encoded. MUST be at least
     * 32 bytes (256 bits) long; a `RangeError` is thrown at
     * construction otherwise. The same key must be available to every server
     * instance that may receive an echoed `requestState` (so a per-process
     * random key only works when one process serves every round of a flow).
     */
    key: Uint8Array | string;

    /**
     * How long a minted `requestState` stays valid, in seconds. An echoed
     * value past its expiry is rejected by {@linkcode RequestStateCodec.verify}.
     * Defaults to `600` (ten minutes).
     */
    ttlSeconds?: number;

    /**
     * Optional context binding. Called at mint time and again at verify time;
     * a `requestState` minted under one binding value is rejected when echoed
     * under a different one. Use this to bind state to the authenticated
     * principal and/or the originating method (the spec's user-binding MUST
     * for state that influences authorization), for example:
     *
     * ```ts
     * bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`
     * ```
     *
     * The returned value is stored in the envelope as a domain-separated HMAC
     * tag (keyed by the codec's `key`), not the raw string — so a principal
     * identifier in the binding does not appear in the wire value the client
     * holds.
     *
     * When configured, {@linkcode RequestStateCodec.mint} requires its `ctx`
     * argument.
     */
    bind?: (ctx: ServerContext) => string;
}

/**
 * The codec returned by {@linkcode createRequestStateCodec}: `mint` seals a
 * JSON-serializable payload into the wire string a handler returns from
 * `inputRequired({ requestState })`; `verify` is the function to drop into
 * {@linkcode server/server.ServerOptions | ServerOptions}`.requestState.verify`
 * (it throws on any failure, which the seam answers as the frozen `-32602`)
 * AND the function a handler calls to read the payload back from
 * `ctx.mcpReq.requestState` after the seam has run.
 */
export interface RequestStateCodec<T = unknown> {
    /**
     * Seal `payload` into an opaque wire string. The result is what the
     * handler returns from `inputRequired({ requestState })`.
     *
     * @param ctx The handler's context. Required when the codec was created
     *            with a {@linkcode RequestStateCodecOptions.bind | bind}
     *            callback; ignored otherwise.
     */
    mint(payload: T, ctx?: ServerContext): Promise<string>;

    /**
     * Verify an echoed `requestState` and return the original payload. Throws
     * on any failure (bad MAC, expired, bind mismatch, malformed). The thrown
     * message is a fixed opaque reason code (`'malformed'` / `'mac'` /
     * `'expired'` / `'bind'`) — never the decoded payload, the binding value,
     * or any other context-derived field.
     *
     * Pass this directly as `ServerOptions.requestState.verify`.
     */
    verify(state: string, ctx: ServerContext): Promise<T>;
}

const PREFIX = 'v1.';

// Runtime-neutral base64url (no padding) over raw bytes. `btoa`/`atob` are
// available in browsers, Cloudflare Workers, and Node 16+.
function bytesToBase64Url(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCodePoint(b);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Constant-time equality on the fixed-length base64url bind-tag string. Same
// guarantee as the body-MAC check (which uses `subtle.verify`): the
// per-character XOR accumulator does not vary its trip count with the position
// of the first mismatch. Length is fixed (22 chars for the 128-bit truncated
// tag), so the early length-check leaks nothing.
function constantTimeTagEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let r = 0;
    for (let i = 0; i < a.length; i++) {
        r |= a.codePointAt(i)! ^ b.codePointAt(i)!;
    }
    return r === 0;
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.codePointAt(i)!;
    return bytes;
}

/**
 * Create an opt-in HMAC-SHA256 codec for the multi-round-trip `requestState`
 * (protocol revision 2026-07-28).
 *
 * `requestState` round-trips through the client and is attacker-controlled
 * input on re-entry. The SDK applies no protection of its own; this helper is
 * the convenience implementation of the spec's integrity MUST so authors don't
 * hand-roll HMAC. Wire shape:
 *
 *     "v1." b64url({"p":<payload>,"exp":<unixSeconds>,"b":<bindTag>?}) "." b64url(mac)
 *
 * where `bindTag` is `b64url(HMAC(key, "mcp.requestState.bind:" + bind(ctx))[:16])`
 * — the binding value is never embedded raw.
 *
 * The codec is **signed, not encrypted**: the body is integrity-protected but
 * the client can base64url-decode it and read the payload (`p`) in clear. Do
 * not put secrets in the payload; use an AEAD construction if confidentiality
 * is required. The handler reads its payload back by calling `verify` again on
 * `ctx.mcpReq.requestState` after the seam has run — re-calling `verify` is
 * the intended pattern (the seam already proved integrity; the second call is
 * the decode).
 *
 * Verification is fail-closed and constant-time (WebCrypto `subtle.verify` for
 * the body MAC; a fixed-length XOR-accumulator compare for the bind tag).
 * See `examples/mrtr/server.ts` for a worked end-to-end example.
 *
 * Design comparison (mcp.d `secureRequestState`, the peer SDK's reference
 * implementation): mcp.d additionally offers an AES-256-GCM encrypted mode and
 * derives independent cipher / bind-HMAC sub-keys from the operator secret via
 * HKDF-SHA256, with an auto-generated per-process ephemeral key when none is
 * supplied. This codec deliberately ships only the signed mode and a single
 * keyed HMAC (domain-separated by input prefix) — HKDF sub-key derivation and
 * an encrypted mode are intentionally out of scope for the initial release.
 */
export function createRequestStateCodec<T = unknown>(options: RequestStateCodecOptions): RequestStateCodec<T> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) {
        throw new TypeError(
            'createRequestStateCodec requires the Web Crypto API (globalThis.crypto.subtle); ' +
                'see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/faq.md for the Node.js polyfill instructions'
        );
    }

    // Snapshot the key bytes at construction. When `options.key` is a
    // Uint8Array, holding the caller's reference would let a post-construction
    // mutation (e.g. zeroing the secret for hygiene) silently change the key
    // the lazy `importedKey()` reads on first mint/verify — a TOCTOU on the
    // secret. The owned copy here is what every later read sees.
    const keyBytes = typeof options.key === 'string' ? new TextEncoder().encode(options.key) : Uint8Array.from(options.key);
    if (keyBytes.byteLength < 32) {
        throw new RangeError(`createRequestStateCodec: key must be at least 32 bytes (got ${keyBytes.byteLength})`);
    }
    const ttlSeconds = options.ttlSeconds ?? 600;
    if (!Number.isFinite(ttlSeconds)) {
        // Infinity/NaN would serialize `exp` as JSON `null`, which then fails
        // verify() with the misleading reason 'expired' on every round-trip —
        // fail loudly at construction instead.
        throw new RangeError('createRequestStateCodec: ttlSeconds must be a finite number');
    }
    const bind = options.bind;

    // The CryptoKey is imported once (lazily) and reused for every mint/verify.
    // `keyBytes` is already an owned standalone Uint8Array (snapshot above), so
    // it satisfies WebCrypto's BufferSource requirement on every runtime.
    let cryptoKey: ReturnType<typeof subtle.importKey> | undefined;
    const importedKey = (): ReturnType<typeof subtle.importKey> =>
        (cryptoKey ??= subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));

    const utf8 = new TextEncoder();

    // Domain-separated HMAC tag of the binding value, truncated to 128 bits and
    // base64url'd. The label keeps the bind-tag computation separate from the
    // body MAC even though both use the same key (the body MAC's input is the
    // versioned wire string `"v1." + base64url(...)` and can never start with
    // this label).
    const BIND_LABEL = 'mcp.requestState.bind:';
    const bindTag = async (value: string): Promise<string> => {
        const mac = new Uint8Array(await subtle.sign('HMAC', await importedKey(), utf8.encode(BIND_LABEL + value)));
        return bytesToBase64Url(mac.slice(0, 16));
    };

    return {
        async mint(payload, ctx) {
            const envelope: { p: T; exp: number; b?: string } = {
                p: payload,
                exp: Math.floor(Date.now() / 1000) + ttlSeconds
            };
            if (bind !== undefined) {
                if (ctx === undefined) {
                    throw new TypeError('createRequestStateCodec: mint() requires ctx when a bind callback is configured');
                }
                envelope.b = await bindTag(bind(ctx));
            }
            const body = bytesToBase64Url(utf8.encode(JSON.stringify(envelope)));
            // The MAC covers `PREFIX + body` so the version tag is bound: a
            // valid `body.mac` pair under `v1.` cannot be transplanted to a
            // future `v2.` codec under the same key.
            const mac = new Uint8Array(await subtle.sign('HMAC', await importedKey(), utf8.encode(PREFIX + body)));
            return `${PREFIX}${body}.${bytesToBase64Url(mac)}`;
        },

        async verify(state, ctx) {
            // Envelope shape: "v1." body "." mac. The MAC is checked FIRST so
            // every other rejection reason is only reachable for a value we
            // minted (or a peer with the key did).
            const dot = state.lastIndexOf('.');
            if (!state.startsWith(PREFIX) || dot <= PREFIX.length) {
                throw new Error('malformed');
            }
            const body = state.slice(PREFIX.length, dot);
            let macBytes: Uint8Array<ArrayBuffer>;
            try {
                macBytes = base64UrlToBytes(state.slice(dot + 1));
            } catch {
                throw new Error('malformed');
            }
            // SubtleCrypto.verify is constant-time by spec — no manual byte
            // compare, no `timingSafeEqual` dependency. The MAC input mirrors
            // mint: `PREFIX + body`, so the version tag is authenticated.
            const ok = await subtle.verify('HMAC', await importedKey(), macBytes, utf8.encode(PREFIX + body));
            if (!ok) {
                throw new Error('mac');
            }
            // The body decoded after a good MAC is by construction the JSON we
            // wrote; a parse failure here would indicate key compromise rather
            // than tampering, but stays fail-closed regardless.
            let envelope: { p: T; exp: number; b?: string };
            try {
                envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(body))) as {
                    p: T;
                    exp: number;
                    b?: string;
                };
            } catch {
                throw new Error('malformed');
            }
            if (typeof envelope.exp !== 'number' || envelope.exp < Math.floor(Date.now() / 1000)) {
                throw new Error('expired');
            }
            if (bind !== undefined) {
                const expected = await bindTag(bind(ctx));
                if (envelope.b === undefined || !constantTimeTagEqual(envelope.b, expected)) {
                    // Opaque reason only — never interpolate the expected/actual
                    // binding values (they may carry principal identifiers).
                    throw new Error('bind');
                }
            } else if (envelope.b !== undefined) {
                // Fail-closed on configuration drift: a token minted with a
                // bind callback is rejected when verified by an instance that
                // has none configured. Accepting it would silently drop the
                // principal-binding guarantee.
                throw new Error('bind');
            }
            return envelope.p;
        }
    };
}
