import { describe, expect, it, vi } from 'vitest';

import type { EventsErrorKind } from '../../../src/ext/events/codes';
import { EVENTS_ERROR_CODES } from '../../../src/ext/events/codes';
import { EventsError } from '../../../src/ext/events/errors';
import { ProtocolError } from '../../../src/types/errors';

describe('EventsError', () => {
    it('fills in the code for its kind and keeps message and data', () => {
        const err = new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' });
        expect([err.code, err.kind, err.data]).toEqual([-32024, 'forbidden', { reason: 'Access revoked' }]);
        expect(err.message).toBe('Forbidden');
        expect(err).toBeInstanceOf(ProtocolError);
        expect(EventsError.isInstance(err)).toBe(true);
        expect(EventsError.isInstance(new ProtocolError(-32024, 'Forbidden'))).toBe(false);
    });

    it('uses the SEP-3415 code table for every kind', () => {
        expect(EVENTS_ERROR_CODES).toEqual({
            invalidParams: -32602,
            notFound: -32023,
            forbidden: -32024,
            resourceExhausted: -32025,
            unsupported: -32026,
            callbackEndpointError: -32027
        });
        for (const [kind, code] of Object.entries(EVENTS_ERROR_CODES)) {
            const err = new EventsError(kind as EventsErrorKind, kind);
            expect([err.code, err.kind]).toEqual([code, kind]);
        }
    });

    it('converts a ProtocolError by code, and leaves codes outside the table alone', () => {
        const notFound = EventsError.fromProtocolError(new ProtocolError(-32023, 'NotFound', { kind: 'event' }));
        expect([notFound?.kind, notFound?.message, notFound?.data]).toEqual(['notFound', 'NotFound', { kind: 'event' }]);
        expect(EventsError.fromProtocolError(new ProtocolError(-32602, 'bad'))?.kind).toBe('invalidParams');
        expect(EventsError.fromProtocolError(new ProtocolError(-32603, 'boom'))).toBeUndefined();
    });

    it('keeps only object data when converting', () => {
        expect(EventsError.fromProtocolError(new ProtocolError(-32025, 'ResourceExhausted', 'subscriptions'))?.data).toBeUndefined();
        expect(EventsError.fromProtocolError(new ProtocolError(-32025, 'ResourceExhausted', ['subscriptions']))?.data).toBeUndefined();
    });

    it('matches across separately loaded module copies', async () => {
        vi.resetModules();
        const foreign = await import('../../../src/ext/events/errors');
        const foreignTypes = await import('../../../src/types/errors');
        // Guard the premise: a cached module would make the checks pass through prototype identity.
        expect(foreign.EventsError).not.toBe(EventsError);
        const err = new foreign.EventsError('unsupported', 'Unsupported', { feature: 'deliveryMode', value: 'push' });
        expect(err instanceof EventsError).toBe(true);
        expect(err instanceof ProtocolError).toBe(true);
        expect(EventsError.isInstance(err)).toBe(true);
        expect(new foreignTypes.ProtocolError(-32026, 'Unsupported') instanceof EventsError).toBe(false);
    });
});
