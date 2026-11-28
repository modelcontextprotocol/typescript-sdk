import { describe, expect, it } from 'vitest';

import { SubscriptionQueue } from '../../../src/ext/events/subscription';
import { occurrence } from './scripted';

describe('the queue a subscription delivers into', () => {
    it('keeps one cursor entry for any number of cursors that come while the loop holds an event, and moves to the latest once the loop moves on', async () => {
        const queue = new SubscriptionQueue('poll', 'c0');
        const iterator = queue[Symbol.asyncIterator]();
        queue.push(occurrence('e1'));
        expect((await iterator.next()).value).toMatchObject({ eventId: 'e1' });

        // A poll result, heartbeat or refresh each, while the loop works on e1.
        for (let n = 1; n <= 100_000; n++) queue.setCursor(`c${n}`);
        expect(queue.backlog).toBe(1);
        expect(queue.cursor).toBe('c0');

        const waiting = iterator.next();
        expect(queue.cursor).toBe('c100000');
        expect(queue.backlog).toBe(0);
        queue.push(occurrence('e2'));
        expect((await waiting).value).toMatchObject({ eventId: 'e2' });
    });

    it('keeps the events in order, each cursor after the events before it', async () => {
        const queue = new SubscriptionQueue('poll', 'c0');
        const iterator = queue[Symbol.asyncIterator]();
        queue.push(occurrence('e1'));
        queue.setCursor('c1');
        queue.setCursor('c2');
        queue.push(occurrence('e2'));
        queue.setCursor('c3');
        queue.setCursor('c4');
        // e1, c2, e2, c4.
        expect(queue.backlog).toBe(4);

        expect((await iterator.next()).value).toMatchObject({ eventId: 'e1' });
        expect(queue.cursor).toBe('c0');
        expect((await iterator.next()).value).toMatchObject({ eventId: 'e2' });
        expect(queue.cursor).toBe('c2');
        void iterator.next();
        expect(queue.cursor).toBe('c4');
    });
});
