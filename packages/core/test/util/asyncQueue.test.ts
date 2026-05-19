import { describe, expect, it } from 'vitest';

import { AsyncQueue } from '../../src/util/asyncQueue.js';

describe('AsyncQueue', () => {
    it('delivers pushed items to a waiting consumer', async () => {
        const q = new AsyncQueue<number>();
        const p = (async () => {
            const out: number[] = [];
            for await (const v of q.iterate()) {
                out.push(v);
                if (out.length === 3) break;
            }
            return out;
        })();
        q.push(1);
        q.push(2);
        q.push(3);
        expect(await p).toEqual([1, 2, 3]);
    });

    it('queues items pushed before consumer starts', async () => {
        const q = new AsyncQueue<number>();
        q.push(1);
        q.push(2);
        const out: number[] = [];
        for await (const v of q.iterate()) {
            out.push(v);
            if (out.length === 2) break;
        }
        expect(out).toEqual([1, 2]);
    });

    it('close() ends iteration after draining queued items', async () => {
        const q = new AsyncQueue<number>();
        q.push(1);
        q.push(2);
        q.close();
        const out: number[] = [];
        for await (const v of q.iterate()) out.push(v);
        expect(out).toEqual([1, 2]);
    });

    it('close() releases a waiting consumer', async () => {
        const q = new AsyncQueue<number>();
        const p = (async () => {
            for await (const _ of q.iterate()) {
                throw new Error('should not yield');
            }
            return 'done';
        })();
        q.close();
        expect(await p).toBe('done');
    });

    it('push() after close() returns false and item is dropped', async () => {
        const q = new AsyncQueue<number>();
        q.close();
        expect(q.push(1)).toBe(false);
        const out: number[] = [];
        for await (const v of q.iterate()) out.push(v);
        expect(out).toEqual([]);
    });

    it('hitting capacity closes the queue (slow-consumer eviction)', async () => {
        const q = new AsyncQueue<number>(2);
        expect(q.push(1)).toBe(true);
        expect(q.push(2)).toBe(true);
        expect(q.push(3)).toBe(false);
        expect(q.closed).toBe(true);
        const out: number[] = [];
        for await (const v of q.iterate()) out.push(v);
        expect(out).toEqual([1, 2]);
    });

    it('breaking out of for-await closes the queue', async () => {
        const q = new AsyncQueue<number>();
        q.push(1);
        for await (const _ of q.iterate()) break;
        expect(q.closed).toBe(true);
        expect(q.push(2)).toBe(false);
    });
});
