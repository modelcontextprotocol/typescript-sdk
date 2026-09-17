import { describe, expect, it } from 'vitest';

import { ProtocolErrorCode } from '../../src/types/enums';
import { ProtocolError, UnsupportedProtocolVersionError } from '../../src/types/errors';

describe('UnsupportedProtocolVersionError', () => {
    const data = { supported: ['2025-11-25', '2025-06-18'], requested: '2026-07-28' };

    it('carries code -32022 and the supported/requested data', () => {
        const error = new UnsupportedProtocolVersionError(data);
        expect(error.code).toBe(ProtocolErrorCode.UnsupportedProtocolVersion);
        expect(error.code).toBe(-32022);
        expect(error.supported).toEqual(['2025-11-25', '2025-06-18']);
        expect(error.requested).toBe('2026-07-28');
        expect(error.data).toEqual(data);
    });

    it('defaults the message from the requested version', () => {
        const error = new UnsupportedProtocolVersionError(data);
        expect(error.message).toBe('Unsupported protocol version: 2026-07-28');
        const custom = new UnsupportedProtocolVersionError(data, 'try another version');
        expect(custom.message).toBe('try another version');
    });

    it('is materialized by ProtocolError.fromError', () => {
        const error = ProtocolError.fromError(-32022, 'Unsupported protocol version: 2026-07-28', data);
        expect(error).toBeInstanceOf(UnsupportedProtocolVersionError);
        if (error instanceof UnsupportedProtocolVersionError) {
            expect(error.supported).toEqual(['2025-11-25', '2025-06-18']);
            expect(error.requested).toBe('2026-07-28');
        }
        expect(error.message).toBe('Unsupported protocol version: 2026-07-28');
    });

    it('falls back to a generic ProtocolError when the data is missing or malformed', () => {
        for (const malformed of [undefined, {}, { supported: 'not-an-array', requested: '2026-07-28' }, { supported: ['2025-11-25'] }]) {
            const error = ProtocolError.fromError(-32022, 'unsupported', malformed);
            expect(error).toBeInstanceOf(ProtocolError);
            expect(error).not.toBeInstanceOf(UnsupportedProtocolVersionError);
            expect(error.code).toBe(-32022);
            expect(error.data).toEqual(malformed);
        }
    });
});
