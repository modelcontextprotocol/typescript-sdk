import type { EventOccurrence, PollEventsRequestParams, PollEventsResult } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import type { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import { makeContext } from './context';
import type { BufferedEvent, EmitBuffer } from './emitBuffer';
import type { SubscriptionSource } from './extension';
import type { Lease } from './leases';
import { leaseKey, LeaseTable } from './leases';
import type { RegisteredEvent } from './registry';
import type { EventContext, EventInput, EventResult } from './types';
import type { SubscriptionValidator } from './validation';

// The page a poll gives when the client asks for none, and every push `check` run's `ctx.maxEvents`.
export const DEFAULT_MAX_EVENTS = 100;
// The largest page one poll reads from the buffer, and a `check` type's `ctx.maxEvents`, whatever `maxEvents` it asks for; `hasMore` reports the rest (SEP-3415: `maxEvents` is a cap).
const MAX_POLL_EVENTS = 1000;
// A `check` event without a timestamp under a `maxAgeMs` floor is reported at once, then at most this often per event type.
const UNTIMED_REPORT_INTERVAL_MS = 60_000;

// Carries the registration whose onSubscribe ran, so onUnsubscribe pairs with it after a removal or re-registration.
interface PollLease extends Lease {
    readonly entry: RegisteredEvent;
    // Aborts when the subscription ends; onSubscribe's `ctx.signal`.
    readonly ended: AbortController;
}

export interface PollDeps {
    readonly validator: SubscriptionValidator;
    readonly buffer: EmitBuffer;
    readonly pollSubscriptionTtlMs: number;
    readonly defaultNextPollMs: number;
    report(error: unknown): void;
}

// `occurrence`, or `undefined` (reported) when JSON cannot carry it, such as a BigInt or a cycle in its `data` or `_meta`.
function serialisable(entry: RegisteredEvent, occurrence: EventOccurrence, report: (error: unknown) => void): EventOccurrence | undefined {
    try {
        JSON.stringify(occurrence);
        return occurrence;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report(new Error(`event '${entry.name}': dropped an event that cannot be serialised to JSON: ${reason}`, { cause: error }));
        return undefined;
    }
}

// The occurrence the SDK sends for an author's event, or `undefined` (reported) when its data fails `payloadSchema` or it cannot be serialised.
export async function toOccurrence(
    entry: RegisteredEvent,
    input: EventInput<unknown>,
    report: (error: unknown) => void
): Promise<EventOccurrence | undefined> {
    const parsed = await entry.parsePayload(input.data);
    if (!parsed.ok) {
        report(new Error(`event '${entry.name}': dropped an event whose data does not match payloadSchema: ${parsed.error}`));
        return undefined;
    }
    const occurrence: EventOccurrence = {
        eventId: input.eventId ?? globalThis.crypto.randomUUID(),
        name: entry.name,
        timestamp: input.timestamp ?? new Date().toISOString(),
        data: parsed.data,
        ...(input._meta === undefined ? {} : { _meta: input._meta })
    };
    return serialisable(entry, occurrence, report);
}

// Without its own timestamp a `check` event carries the time it was read, which no floor skips, so it is delivered and reported.
function reportUntimed(entry: RegisteredEvent, report: (error: unknown) => void): void {
    const now = Date.now();
    const { untimed } = entry;
    if (untimed.reportedAt !== undefined && now - untimed.reportedAt < UNTIMED_REPORT_INTERVAL_MS) return;
    untimed.reportedAt = now;
    report(new Error(`event '${entry.name}': check returned an event without a timestamp, so maxAgeMs cannot skip it; it is delivered`));
}

// A check result's events to send, for every mode: ones without an eventId or off-schema dropped (reported), ones older than `maxAgeMs` skipped with `truncated` unless the result has no replay (`cursor: null`), which `maxAgeMs` does not apply to.
export async function checkedEvents(
    entry: RegisteredEvent,
    result: EventResult<unknown>,
    maxAgeMs: number | undefined,
    report: (error: unknown) => void
): Promise<{ events: EventOccurrence[]; truncated: boolean }> {
    const floor = maxAgeMs === undefined || result.cursor === null ? undefined : Date.now() - maxAgeMs;
    let truncated = result.truncated === true;
    const events: EventOccurrence[] = [];
    for (const input of result.events) {
        // A generated id would differ on every read of the event, so only emit() makes one.
        if (typeof input.eventId !== 'string' || input.eventId === '') {
            report(new Error(`event '${entry.name}': dropped an event from check without an eventId`));
            continue;
        }
        const occurrence = await toOccurrence(entry, input, report);
        if (occurrence === undefined) continue;
        if (floor !== undefined && input.timestamp === undefined) reportUntimed(entry, report);
        if (floor !== undefined && Date.parse(occurrence.timestamp) < floor) {
            truncated = true;
            continue;
        }
        events.push(occurrence);
    }
    // A `cursor: null` result (no replay) has no position to skip past, so it never reports `truncated` (SEP-3415 §Cursor Lifecycle).
    return { events, truncated: truncated && result.cursor !== null };
}

// What one subscription receives of an emitted event: nothing unless `match` accepts it, shaped by `transform`. A throwing hook skips the event.
export function selectEvent(
    entry: RegisteredEvent,
    ctx: EventContext,
    args: Record<string, unknown>,
    { occurrence }: BufferedEvent,
    report: (error: unknown) => void
): EventOccurrence | undefined {
    const { match, transform } = entry.definition;
    try {
        if (match !== undefined && !match(ctx, occurrence, args)) return undefined;
        if (transform === undefined) return occurrence;
        const shaped = transform(ctx, occurrence, args);
        return {
            eventId: shaped.eventId ?? occurrence.eventId,
            name: occurrence.name,
            timestamp: shaped.timestamp ?? occurrence.timestamp,
            data: shaped.data as Record<string, unknown>,
            ...(shaped._meta === undefined ? {} : { _meta: shaped._meta })
        };
    } catch (error) {
        report(error);
        return undefined;
    }
}

// A selected event whose `transform` output fails `payloadSchema` or cannot be serialised is dropped (reported), as such an emit is; without a transform it was checked at emit.
export async function checkedSelection(
    entry: RegisteredEvent,
    occurrence: EventOccurrence,
    report: (error: unknown) => void
): Promise<EventOccurrence | undefined> {
    if (entry.definition.transform === undefined) return occurrence;
    try {
        const parsed = await entry.parsePayload(occurrence.data);
        if (parsed.ok) return serialisable(entry, { ...occurrence, data: parsed.data }, report);
        report(new Error(`event '${entry.name}': dropped an event whose transform output does not match payloadSchema: ${parsed.error}`));
    } catch (error) {
        report(error);
    }
    return undefined;
}

// `events/poll`: every request carries one subscription, and leases drive `onSubscribe` / `onUnsubscribe` (SEP-3415 Appendix A).
export class PollSource implements SubscriptionSource {
    readonly #deps: PollDeps;
    readonly #leases: LeaseTable<PollLease>;
    // First-sight onSubscribe calls in flight, so a concurrent poll for the same lease waits for the outcome.
    readonly #starting = new Map<string, Promise<void>>();
    // The longest `nextPollMs` sent, so a client that waits it polls before its lease lapses.
    readonly #maxNextPollMs: number;

    constructor(deps: PollDeps) {
        this.#deps = deps;
        this.#maxNextPollMs = Math.floor(deps.pollSubscriptionTtlMs / 2);
        this.#leases = new LeaseTable<PollLease>(deps.pollSubscriptionTtlMs, lease => {
            if (lease.terminated === undefined) void this.#unsubscribe(lease);
        });
    }

    get size(): number {
        return this.#leases.size;
    }

    countOf(principal: string | null): number {
        return this.#leases.countOf(principal);
    }

    async handlePoll(params: PollEventsRequestParams, ctx: ServerContext): Promise<PollEventsResult> {
        let key = '';
        const { entry, principal, args } = await this.#deps.validator.validate('poll', params, ctx, async (principal, rawArgs) => {
            key = await leaseKey(principal, params.name, rawArgs);
            this.#throwTerminated(key);
        });
        const { lease, created } = await this.#lease(key, entry, principal, args);
        const fields = {
            name: entry.name,
            subscriptionId: lease.subscriptionId,
            principal,
            mode: 'poll' as const,
            signal: ctx.mcpReq.signal
        };
        const maxEvents = Math.min(params.maxEvents ?? DEFAULT_MAX_EVENTS, MAX_POLL_EVENTS);
        const cursor = params.cursor ?? null;
        const { check } = entry.definition;
        if (check === undefined) {
            const selectCtx = makeContext(fields);
            const read = this.#deps.buffer.read(entry.name, cursor, {
                maxEvents,
                maxAgeMs: params.maxAgeMs,
                select: buffered => selectEvent(entry, selectCtx, args, buffered, this.#deps.report)
            });
            const checked = await Promise.all(read.events.map(occurrence => checkedSelection(entry, occurrence, this.#deps.report)));
            const events = checked.filter((occurrence): occurrence is EventOccurrence => occurrence !== undefined);
            return { ...read, events, nextPollMs: this.#nextPollMs(undefined) };
        }

        const result = await check(makeContext({ ...fields, maxEvents, maxAgeMs: params.maxAgeMs }), args, cursor);
        const nextPollMs = this.#nextPollMs(result.nextPollMs);
        // `null` starts from now on a new lease or for a type with replay; on a lease's later polls a type without replay gets its events.
        if (cursor === null && (created || result.cursor !== null)) {
            return { events: [], cursor: result.cursor, truncated: false, hasMore: false, nextPollMs };
        }
        const { events, truncated } = await checkedEvents(entry, result, params.maxAgeMs, this.#deps.report);
        return { events, cursor: result.cursor, truncated, hasMore: result.hasMore === true, nextPollMs };
    }

    // Marks the leases; their next poll answers with `error`, and onUnsubscribe runs now.
    async terminate(name: string, error: EventsError, subscriptionId?: string): Promise<void> {
        const ended: PollLease[] = [];
        // eslint-disable-next-line unicorn/no-array-for-each, unicorn/no-array-callback-reference, unicorn/no-array-method-this-argument -- LeaseTable.forEach(name, fn), not Array#forEach
        this.#leases.forEach(name, lease => {
            if (lease.terminated !== undefined || (subscriptionId !== undefined && lease.subscriptionId !== subscriptionId)) return;
            lease.terminated = error;
            ended.push(lease);
        });
        await Promise.all(ended.map(lease => this.#unsubscribe(lease)));
    }

    // Drops every lease without onUnsubscribe, as a process restart would.
    clear(): void {
        this.#leases.clear();
        this.#starting.clear();
    }

    // Whole milliseconds, at least 0 and at most #maxNextPollMs; anything but a finite number sends the default.
    #nextPollMs(value: number | undefined): number {
        const ms = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : this.#deps.defaultNextPollMs;
        return Math.min(ms, this.#maxNextPollMs);
    }

    // A terminated lease answers its error once, then is gone.
    #throwTerminated(key: string): void {
        const terminated = this.#leases.get(key)?.terminated;
        if (terminated === undefined) return;
        this.#leases.delete(key);
        throw terminated;
    }

    // Renews the lease, or on first sight checks the quota and runs onSubscribe; `created` on first sight.
    async #lease(
        key: string,
        entry: RegisteredEvent,
        principal: string | null,
        args: Record<string, unknown>
    ): Promise<{ lease: PollLease; created: boolean }> {
        const pending = this.#starting.get(key);
        // Await only a pending start: an unconditional await would let a concurrent first poll in before `touch`.
        if (pending !== undefined) await pending;
        if (this.#leases.get(key) === undefined) this.#deps.validator.assertCapacity(principal);
        const { lease, created } = this.#leases.touch(key, () => ({
            subscriptionId: globalThis.crypto.randomUUID(),
            name: entry.name,
            principal,
            args,
            entry,
            ended: new AbortController()
        }));
        if (!created) return { lease, created };
        const ctx = makeContext({
            name: entry.name,
            subscriptionId: lease.subscriptionId,
            principal,
            mode: 'poll',
            signal: lease.ended.signal
        });
        // A termination meanwhile answers as itself, here and to a poll waiting on this start, not as the abort it caused in a hook that honours `ctx.signal`.
        const starting = (async () => entry.definition.onSubscribe?.(ctx, args))().catch((error: unknown) => {
            throw lease.terminated ?? error;
        });
        this.#starting.set(key, starting);
        try {
            await starting;
        } catch (error) {
            this.#leases.delete(key);
            throw error;
        } finally {
            this.#starting.delete(key);
        }
        return { lease, created };
    }

    async #unsubscribe(lease: PollLease): Promise<void> {
        const { name, subscriptionId, principal, args, entry, ended } = lease;
        ended.abort();
        const ctx = makeContext({ name, subscriptionId, principal, mode: 'poll', signal: ended.signal });
        try {
            await entry.definition.onUnsubscribe?.(ctx, args);
        } catch (error) {
            this.#deps.report(error);
        }
    }
}
