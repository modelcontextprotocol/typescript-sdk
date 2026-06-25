/**
 * The `-32021` MissingRequiredClientCapability typed error.
 *
 * Recognition is data-parse based: a peer (or another bundled copy of the SDK)
 * is recognized by the error code plus the `data.requiredCapabilities` shape,
 * never by `instanceof` across bundles.
 */
import { describe, expect, test } from 'vitest';

import { ProtocolErrorCode } from '../../src/types/enums';
import { MissingRequiredClientCapabilityError, ProtocolError } from '../../src/types/errors';

describe('MissingRequiredClientCapabilityError', () => {
    test('carries the -32021 code and the missing capabilities in data.requiredCapabilities', () => {
        const error = new MissingRequiredClientCapabilityError({ requiredCapabilities: { sampling: {}, elicitation: { url: {} } } });
        expect(error.code).toBe(ProtocolErrorCode.MissingRequiredClientCapability);
        expect(error.code).toBe(-32_021);
        expect(error.requiredCapabilities).toEqual({ sampling: {}, elicitation: { url: {} } });
        expect(error.data).toEqual({ requiredCapabilities: { sampling: {}, elicitation: { url: {} } } });
        expect(error.message).toContain('sampling');
        expect(error.message).toContain('elicitation');
    });

    test('a custom message is preserved', () => {
        const error = new MissingRequiredClientCapabilityError({ requiredCapabilities: { sampling: {} } }, 'declare sampling first');
        expect(error.message).toBe('declare sampling first');
    });

    test('fromError recognizes the code + data shape (the cross-bundle data-parse path)', () => {
        // Simulates an error received from the wire or from a separately
        // bundled SDK copy: plain code/message/data, no class identity.
        const wireShape = {
            code: -32_021,
            message: 'Missing required client capabilities: sampling',
            data: { requiredCapabilities: { sampling: {} } }
        };
        const recognized = ProtocolError.fromError(wireShape.code, wireShape.message, wireShape.data);
        expect(recognized).toBeInstanceOf(MissingRequiredClientCapabilityError);
        expect((recognized as MissingRequiredClientCapabilityError).requiredCapabilities).toEqual({ sampling: {} });
    });

    test('fromError falls back to the generic ProtocolError when the data shape does not match', () => {
        expect(ProtocolError.fromError(-32_021, 'missing', undefined)).not.toBeInstanceOf(MissingRequiredClientCapabilityError);
        expect(ProtocolError.fromError(-32_021, 'missing', { requiredCapabilities: ['sampling'] })).not.toBeInstanceOf(
            MissingRequiredClientCapabilityError
        );
        expect(ProtocolError.fromError(-32_021, 'missing', { somethingElse: true })).not.toBeInstanceOf(
            MissingRequiredClientCapabilityError
        );
        expect(ProtocolError.fromError(-32_021, 'missing', { requiredCapabilities: { sampling: {} } })).toBeInstanceOf(
            MissingRequiredClientCapabilityError
        );
    });

    test('recognition by code and data shape works on plain values (no instanceof needed)', () => {
        const fromAnotherBundle: { code: number; data?: unknown } = new MissingRequiredClientCapabilityError({
            requiredCapabilities: { sampling: {} }
        });
        const looksLikeMissingCapability =
            fromAnotherBundle.code === -32_021 &&
            typeof (fromAnotherBundle.data as { requiredCapabilities?: unknown } | undefined)?.requiredCapabilities === 'object';
        expect(looksLikeMissingCapability).toBe(true);
    });
});
