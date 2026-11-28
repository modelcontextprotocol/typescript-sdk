import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '../../../src/client/auth';
import type { Client } from '../../../src/client/client';
import type { EventSubscription } from '../../../src/ext/events/index';
import type { Handler } from './scripted';
import { callsTo, descriptor, httpEvents, listing, occurrence, script } from './scripted';

const subscriptions: EventSubscription[] = [];
const clients: Client[] = [];

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    await Promise.all(subscriptions.splice(0).map(subscription => subscription.cancel()));
    await Promise.all(clients.splice(0).map(client => client.close()));
    vi.useRealTimers();
});

/** The eventId of the loop's next event, `undefined` when the loop is done. */
async function nextEventId(iterator: AsyncIterator<{ eventId: string }>): Promise<string | undefined> {
    const result = await iterator.next();
    return result.done ? undefined : result.value.eventId;
}

/**
 * A poll subscription over Streamable HTTP whose server accepts only the bearer token `valid` holds: a 401 runs
 * `onUnauthorized`, which renews the token from `valid` unless `failure` gives it an error to throw for its call.
 */
async function pollOverHttp(poll: Handler, failure: (call: number) => unknown) {
    const tokens = { current: 't1', valid: 't1' };
    const onUnauthorized = vi.fn(async () => {
        const error = failure(onUnauthorized.mock.calls.length);
        if (error !== undefined) throw error;
        tokens.current = tokens.valid;
    });
    const { events, client, calls } = await httpEvents(
        { 'events/list': listing(descriptor('tick')), 'events/poll': poll },
        { token: async () => tokens.current, onUnauthorized },
        token => token === tokens.valid
    );
    clients.push(client);
    // Listed first, as an app does after connecting, so subscribe() looks the type up without a request.
    await events.list();
    const errors: Error[] = [];
    client.onerror = error => void errors.push(error);
    return {
        tokens,
        onUnauthorized,
        // What the Events loop reported; the transport reports its own failures too.
        reports: () => errors.filter(error => error.message.startsWith("poll subscription to 'tick'")),
        polls: () => callsTo(calls, 'events/poll'),
        subscribe: async () => {
            const subscription = await events.subscribe({ name: 'tick', delivery: 'poll' });
            subscriptions.push(subscription);
            return subscription;
        }
    };
}

describe('auth failures of an Events subscription over Streamable HTTP', () => {
    it.each([
        ['a network error', () => new TypeError('fetch failed')],
        ['an OAuthError server_error', () => new OAuthError(OAuthErrorCode.ServerError, 'HTTP 503: Invalid OAuth error response')],
        ['an OAuthError temporarily_unavailable', () => new OAuthError(OAuthErrorCode.TemporarilyUnavailable, 'Try again later')],
        ['an OAuthError too_many_requests', () => new OAuthError(OAuthErrorCode.TooManyRequests, 'Slow down')]
    ])('retries %s of onUnauthorized on a live subscription, reports it, and delivers once the token is renewed', async (_case, make) => {
        const thrown = make();
        const { tokens, onUnauthorized, reports, polls, subscribe } = await pollOverHttp(
            script(
                { events: [occurrence('e1')], cursor: 'c1', nextPollMs: 0 },
                { events: [occurrence('e2')], cursor: 'c2', nextPollMs: 60_000 }
            ),
            call => (call === 1 ? thrown : undefined)
        );
        const iterator = (await subscribe())[Symbol.asyncIterator]();
        expect(await nextEventId(iterator)).toBe('e1');

        // The token lapses: the next poll gets a 401, and onUnauthorized fails once.
        tokens.valid = 't2';
        await vi.advanceTimersByTimeAsync(1000);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(reports()).toEqual([expect.objectContaining({ message: expect.stringContaining('failed and is retried'), cause: thrown })]);

        // The retry runs onUnauthorized again, which renews the token, and the poll delivers.
        await vi.advanceTimersByTimeAsync(1000);
        expect(onUnauthorized).toHaveBeenCalledTimes(2);
        expect(await nextEventId(iterator)).toBe('e2');
        expect(polls()).toHaveLength(2);
    });

    it('ends the loop on an UnauthorizedError of onUnauthorized, without running it again', async () => {
        const { tokens, onUnauthorized, polls, subscribe } = await pollOverHttp(
            script({ events: [], cursor: 'c1', nextPollMs: 0 }),
            () => new UnauthorizedError()
        );
        const subscription = await subscribe();
        const pending = subscription[Symbol.asyncIterator]()
            .next()
            .catch((error: unknown) => error);

        tokens.valid = 't2';
        await vi.advanceTimersByTimeAsync(1000);
        expect(await pending).toBeInstanceOf(UnauthorizedError);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(polls()).toHaveLength(1);
    });

    it('rejects subscribe() when onUnauthorized fails with a network error on the first poll, without retrying', async () => {
        const thrown = new TypeError('fetch failed');
        const { tokens, onUnauthorized, reports, polls, subscribe } = await pollOverHttp(
            script({ events: [occurrence('e1')], cursor: 'c1', nextPollMs: 60_000 }),
            () => thrown
        );
        tokens.valid = 't2';
        expect(await subscribe().catch((error: unknown) => error)).toBe(thrown);
        expect(reports()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(onUnauthorized).toHaveBeenCalledOnce();
        expect(polls()).toHaveLength(0);
    });
});
