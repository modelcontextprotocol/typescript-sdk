import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { EventsError } from '../../../src/ext/events/index';
import { recoveryFor, refusesSubscription, reportGap } from '../../../src/ext/events/recovery';
import type { EventsConnection } from '../../../src/ext/events/request';
import { authFailure } from './scripted';

const httpError = (status: number) =>
    new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${status}`, { status });

describe('the recovery rules every delivery mode shares', () => {
    it.each([
        ['notFound', 'relist', true, new EventsError('notFound', 'Not found', { kind: 'event' })],
        [
            'unsupported, schema changed',
            'relist',
            true,
            new EventsError('unsupported', 'Unsupported', { feature: 'payloadSchema', reason: 'schema_changed' })
        ],
        ['unsupported, other', 'fail', true, new EventsError('unsupported', 'Unsupported', { feature: 'deliveryMode', value: 'push' })],
        ['forbidden', 'fail', true, new EventsError('forbidden', 'Forbidden')],
        ['invalidParams', 'fail', true, new EventsError('invalidParams', 'Invalid arguments')],
        ['resourceExhausted', 'fail', true, new EventsError('resourceExhausted', 'Too many', { limit: 'subscriptions' })],
        [
            'resourceExhausted, per principal',
            'fail',
            true,
            new EventsError('resourceExhausted', 'Too many', { limit: 'principalSubscriptions', max: 256 })
        ],
        [
            'resourceExhausted, verification',
            'retry',
            false,
            new EventsError('resourceExhausted', 'Too many verifications', { limit: 'verification', retryAfterMs: 5000 })
        ],
        ['callbackEndpointError', 'fail', true, new EventsError('callbackEndpointError', 'Unreachable', { reason: 'timeout' })],
        ['-32020', 'mismatch', true, new ProtocolError(-32_020, 'Mcp-Param-Region header mismatch')],
        ['-32601', 'fail', true, new ProtocolError(-32_601, 'Method not found')],
        ['another JSON-RPC error', 'retry', false, new ProtocolError(-32_603, 'Internal error')],
        ['an auth failure', 'fail', true, authFailure()],
        ['an SDK error', 'retry', true, new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out')],
        ['an HTTP 503', 'retry', false, httpError(503)],
        ['an HTTP 429', 'retry', false, httpError(429)],
        ['an HTTP 404', 'retry', true, httpError(404)],
        ['a transport error', 'retry', false, new Error('fetch failed')]
    ] as const)('%s → %s once subscribed; refuses a first exchange: %s', (_name, recovery, refuses, error) => {
        expect(recoveryFor(error)).toBe(recovery);
        expect(refusesSubscription(error)).toBe(refuses);
    });

    it('reports a gap through onGap, and a throwing onGap to the client onerror', () => {
        const connection = { report: vi.fn() } as unknown as EventsConnection;
        const onGap = vi.fn();
        reportGap({ name: 'tick', onGap }, connection, 'c1');
        expect(onGap).toHaveBeenCalledExactlyOnceWith('c1');
        expect(connection.report).not.toHaveBeenCalled();

        const failure = new Error('onGap failed');
        reportGap(
            {
                name: 'tick',
                onGap: () => {
                    throw failure;
                }
            },
            connection,
            null
        );
        expect(connection.report).toHaveBeenCalledExactlyOnceWith(failure);
    });
});
