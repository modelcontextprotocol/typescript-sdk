/**
 * Cross-bundle typed-error recognition guard.
 *
 * The core package is bundled separately into the client and server dists, so
 * a typed error class constructed inside one bundle is NOT `instanceof` the
 * "same" class imported from another bundle. The recognition contract is
 * therefore: typed protocol errors are materialized from the wire shape —
 * numeric `code` plus structurally parsed `error.data` — and consumers (and
 * the SDK itself) must never rely on `instanceof` across the package boundary.
 *
 * These tests pin that contract from both directions:
 *  - recognition succeeds for plain wire values and for foreign-prototype
 *    instances (simulating an error object created by another bundled copy of
 *    core), and
 *  - recognition is purely structural — malformed `data` falls back to the
 *    generic class rather than guessing or throwing.
 */
import { describe, expect, test } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol.js';
import { Protocol } from '../../src/shared/protocol.js';
import { InMemoryTransport } from '../../src/util/inMemory.js';
import type { JSONRPCRequest } from '../../src/types/index.js';
import { ProtocolError, ProtocolErrorCode, UnsupportedProtocolVersionError, UrlElicitationRequiredError } from '../../src/types/index.js';

class TestProtocol extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/**
 * A structural twin of `UnsupportedProtocolVersionError` with its own
 * prototype chain — what an error created by a second bundled copy of core
 * looks like to this copy: same name, same fields, different identity.
 */
class ForeignUnsupportedProtocolVersionError extends Error {
    readonly code = -32_004;
    readonly data = { supported: ['2025-11-25'], requested: '2099-01-01' };
    constructor() {
        super('Unsupported protocol version: 2099-01-01');
        this.name = 'UnsupportedProtocolVersionError';
    }
}

describe('cross-bundle typed-error recognition (data parse, never instanceof)', () => {
    test('a -32004 error received over the wire materializes the typed class from code + data', async () => {
        // Full dispatch round trip: the peer answers with a plain JSON error
        // body — exactly what crosses a transport (and a bundle) boundary.
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        serverTx.onmessage = message => {
            const request = message as JSONRPCRequest;
            void serverTx.send({
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32_004,
                    message: 'Unsupported protocol version',
                    data: { supported: ['2025-11-25', '2025-06-18'], requested: '2099-01-01' }
                }
            });
        };
        await serverTx.start();

        const protocol = new TestProtocol();
        await protocol.connect(clientTx);

        const rejection = await protocol.request({ method: 'ping' }).catch((error: unknown) => error);

        // The receiving side gets the typed class, materialized purely from
        // the wire shape (numeric code + structurally valid data).
        expect(rejection).toBeInstanceOf(UnsupportedProtocolVersionError);
        const typed = rejection as UnsupportedProtocolVersionError;
        expect(typed.code).toBe(ProtocolErrorCode.UnsupportedProtocolVersion);
        expect(typed.supported).toEqual(['2025-11-25', '2025-06-18']);
        expect(typed.requested).toBe('2099-01-01');

        await protocol.close();
    });

    test('recognition works for a foreign-prototype instance via its code/data, not its identity', () => {
        const foreign = new ForeignUnsupportedProtocolVersionError();

        // The foreign instance is NOT instanceof this bundle's classes — the
        // exact situation `instanceof` checks silently get wrong.
        expect(foreign instanceof UnsupportedProtocolVersionError).toBe(false);
        expect(foreign instanceof ProtocolError).toBe(false);

        // Recognition through the wire shape still succeeds.
        const recognized = ProtocolError.fromError(foreign.code, foreign.message, foreign.data);
        expect(recognized).toBeInstanceOf(UnsupportedProtocolVersionError);
        expect((recognized as UnsupportedProtocolVersionError).supported).toEqual(['2025-11-25']);
        expect((recognized as UnsupportedProtocolVersionError).requested).toBe('2099-01-01');
    });

    test('recognition survives JSON serialization (no prototype information required)', () => {
        // Serialize a locally constructed typed error down to its wire shape
        // and re-recognize it — the round trip a bundled boundary forces.
        const original = new UrlElicitationRequiredError([
            { mode: 'url', message: 'visit', url: 'https://example.com/elicit', elicitationId: 'e1' }
        ]);
        const wireShape = JSON.parse(JSON.stringify({ code: original.code, message: original.message, data: original.data })) as {
            code: number;
            message: string;
            data: unknown;
        };

        const recognized = ProtocolError.fromError(wireShape.code, wireShape.message, wireShape.data);
        expect(recognized).toBeInstanceOf(UrlElicitationRequiredError);
        expect((recognized as UrlElicitationRequiredError).elicitations).toHaveLength(1);
        expect((recognized as UrlElicitationRequiredError).elicitations[0]?.url).toBe('https://example.com/elicit');
    });

    test('structurally invalid data falls back to the generic class — no guess, no throw', () => {
        // -32004 with data that does not parse as UnsupportedProtocolVersionErrorData.
        for (const data of [undefined, null, 'nope', { supported: 'not-an-array', requested: '2099-01-01' }, { wrong: 'shape' }]) {
            const recognized = ProtocolError.fromError(-32_004, 'unsupported', data);
            expect(recognized).toBeInstanceOf(ProtocolError);
            expect(recognized).not.toBeInstanceOf(UnsupportedProtocolVersionError);
            expect(recognized.code).toBe(-32_004);
        }

        // -32042 with data missing the elicitations array.
        const urlFallback = ProtocolError.fromError(-32_042, 'elicitation required', { other: true });
        expect(urlFallback).toBeInstanceOf(ProtocolError);
        expect(urlFallback).not.toBeInstanceOf(UrlElicitationRequiredError);
    });
});
