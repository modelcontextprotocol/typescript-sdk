import type { PollEventsResult } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_POLL_METHOD, PollEventsResultSchema } from '@modelcontextprotocol/core/ext/events';

import { DriverLoop } from './recovery';
import type { Driver, DriverContext } from './subscription';

const MAX_RETRY_DELAY_MS = 60_000;

// Poll delivery (spec §6.3): one `events/poll` loop, again at once on a `hasMore` page that made progress, otherwise after `nextPollMs` (the floor on `hasMore` without progress) but never sooner than the floor; no poll goes out while the queue is full.
export class PollDriver<T> implements Driver {
    readonly #context: DriverContext<T>;
    readonly #loop: DriverLoop<T>;
    readonly #floorMs: number;
    #nextPollMs: number | undefined;
    // The last result was a `truncated` page with more waiting (`hasMore`): the results that continue that run report no further gap.
    #truncating = false;

    constructor(context: DriverContext<T>, floorMs: number) {
        this.#context = context;
        this.#loop = new DriverLoop(context, 'poll');
        this.#floorMs = floorMs;
    }

    start(): Promise<void> {
        return this.#loop.start(() => this.#run());
    }

    stop(): Promise<void> {
        return this.#loop.stop();
    }

    // Polls until stopped; throws, ending the subscription, when a failure calls for it.
    async #run(): Promise<void> {
        const loop = this.#loop;
        let failures = 0;
        while (!loop.ended) {
            await loop.room();
            if (loop.ended) return;
            const sent = loop.cursor;
            let result: PollEventsResult;
            try {
                result = await this.#poll(sent);
            } catch (error) {
                if (loop.ended) return;
                if ((await loop.recover(error)) === 'restarted') continue;
                await loop.sleep(this.#retryDelay(failures++));
                continue;
            }
            if (loop.ended) return;
            failures = 0;
            this.#deliver(result);
            loop.subscribed();
            if (result.hasMore !== true) await loop.sleep(Math.max(result.nextPollMs ?? this.#floorMs, this.#floorMs));
            // A `hasMore` page with no events that is `truncated` or kept the cursor made no progress (a replica that does not know the cursor, say), so it waits the floor.
            else if (result.events.length === 0 && (result.truncated === true || (result.cursor ?? null) === sent)) {
                await loop.sleep(this.#floorMs);
            }
        }
    }

    #poll(cursor: string | null): Promise<PollEventsResult> {
        const { name, arguments: args } = this.#context.subscription;
        const loop = this.#loop;
        const mirror = { name, ...(args !== undefined && { arguments: args }) };
        const { maxAgeMs } = loop;
        const params = { ...mirror, cursor, ...(maxAgeMs !== undefined && { maxAgeMs }) };
        return this.#context.connection.request(EVENTS_POLL_METHOD, params, PollEventsResultSchema, mirror, { signal: loop.signal });
    }

    #deliver(result: PollEventsResult): void {
        const cursor = result.cursor ?? null;
        this.#nextPollMs = result.nextPollMs;
        const truncated = result.truncated === true;
        // One `onGap` per run of truncated `hasMore` pages (a stale cursor's catch-up under `maxAgeMs`, say); a clean result, or one with nothing more waiting, ends the run.
        this.#loop.succeeded(cursor, truncated && !this.#truncating);
        this.#truncating = truncated && result.hasMore === true;
        for (const event of result.events) this.#context.queue.push(event);
        this.#loop.setCursor(cursor);
    }

    // max(floor, nextPollMs), doubling per consecutive failure up to 60 s, never below that base.
    #retryDelay(failures: number): number {
        const base = Math.max(this.#floorMs, this.#nextPollMs ?? this.#floorMs);
        return Math.max(base, Math.min(MAX_RETRY_DELAY_MS, base * 2 ** failures));
    }
}
