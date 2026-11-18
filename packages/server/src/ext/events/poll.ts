import type { EventOccurrence, PollEventsRequestParams, PollEventsResult } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import type { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import { makeContext } from './context';
import type { BufferedEvent, EmitBuffer } from './emitBuffer';
import type { SubscriptionSource } from './extension';
import type { Lease } from './leases';
import { leaseKey, LeaseTable } from './leases';
import type { RegisteredEvent } from './registry';
import type { EventContext, EventInput } from './types';
import type { SubscriptionValidator } from './validation';

const DEFAULT_MAX_EVENTS = 100;

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

// The occurrence the SDK sends for an author's event, or `undefined` (reported) when its data fails `payloadSchema`.
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
    return {
        eventId: input.eventId ?? globalThis.crypto.randomUUID(),
        name: entry.name,
        timestamp: input.timestamp ?? new Date().toISOString(),
        data: parsed.data,
        ...(input._meta === undefined ? {} : { _meta: input._meta })
    };
}

// `events/poll`: every request carries one subscription, and leases drive `onSubscribe` / `onUnsubscribe` (SEP-3415 Appendix A).
export class PollSource implements SubscriptionSource {
    readonly #deps: PollDeps;
    readonly #leases: LeaseTable<PollLease>;
    // First-sight onSubscribe calls in flight, so a concurrent poll for the same lease waits for the outcome.
    readonly #starting = new Map<string, Promise<void>>();

    constructor(deps: PollDeps) {
        this.#deps = deps;
        this.#leases = new LeaseTable<PollLease>(deps.pollSubscriptionTtlMs, lease => {
            if (lease.terminated === undefined) void this.#unsubscribe(lease);
        });
    }

    get size(): number {
        return this.#leases.size;
    }

    async handlePoll(params: PollEventsRequestParams, ctx: ServerContext): Promise<PollEventsResult> {
        let key = '';
        const { entry, principal, args } = await this.#deps.validator.validate('poll', params, ctx, (principal, rawArgs) => {
            key = leaseKey(principal, params.name, rawArgs);
            this.#throwTerminated(key);
        });
        const lease = await this.#lease(key, entry, principal, args);
        const fields = {
            name: entry.name,
            subscriptionId: lease.subscriptionId,
            principal,
            mode: 'poll' as const,
            signal: ctx.mcpReq.signal
        };
        const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
        const cursor = params.cursor ?? null;
        const { check } = entry.definition;
        if (check === undefined) {
            const selectCtx = makeContext(fields);
            const read = this.#deps.buffer.read(entry.name, cursor, {
                maxEvents,
                maxAgeMs: params.maxAgeMs,
                select: buffered => this.#select(entry, selectCtx, args, buffered)
            });
            return { ...read, nextPollMs: this.#deps.defaultNextPollMs };
        }

        const result = await check(makeContext({ ...fields, maxEvents, maxAgeMs: params.maxAgeMs }), args, cursor);
        const nextPollMs = result.nextPollMs ?? this.#deps.defaultNextPollMs;
        if (cursor === null) return { events: [], cursor: result.cursor, truncated: false, hasMore: false, nextPollMs };
        const floor = params.maxAgeMs === undefined ? undefined : Date.now() - params.maxAgeMs;
        let truncated = result.truncated === true;
        const events: EventOccurrence[] = [];
        for (const input of result.events) {
            const occurrence = await toOccurrence(entry, input, this.#deps.report);
            if (occurrence === undefined) continue;
            if (floor !== undefined && Date.parse(occurrence.timestamp) < floor) {
                truncated = true;
                continue;
            }
            events.push(occurrence);
        }
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

    // A terminated lease answers its error once, then is gone.
    #throwTerminated(key: string): void {
        const terminated = this.#leases.get(key)?.terminated;
        if (terminated === undefined) return;
        this.#leases.delete(key);
        throw terminated;
    }

    // Renews the lease, or on first sight checks the quota and runs onSubscribe.
    async #lease(key: string, entry: RegisteredEvent, principal: string | null, args: Record<string, unknown>): Promise<PollLease> {
        const pending = this.#starting.get(key);
        // Await only a pending start: an unconditional await would let a concurrent first poll in before `touch`.
        if (pending !== undefined) await pending;
        if (this.#leases.get(key) === undefined) this.#deps.validator.assertCapacity();
        const { lease, created } = this.#leases.touch(key, () => ({
            subscriptionId: globalThis.crypto.randomUUID(),
            name: entry.name,
            principal,
            args,
            entry,
            ended: new AbortController()
        }));
        if (!created) return lease;
        const ctx = makeContext({
            name: entry.name,
            subscriptionId: lease.subscriptionId,
            principal,
            mode: 'poll',
            signal: lease.ended.signal
        });
        const starting = (async () => entry.definition.onSubscribe?.(ctx, args))();
        this.#starting.set(key, starting);
        try {
            await starting;
        } catch (error) {
            this.#leases.delete(key);
            throw error;
        } finally {
            this.#starting.delete(key);
        }
        return lease;
    }

    // Broadcast events pass `match`; targeted ones reach only their subscription. A throwing hook skips the event.
    #select(
        entry: RegisteredEvent,
        ctx: EventContext,
        args: Record<string, unknown>,
        buffered: BufferedEvent
    ): EventOccurrence | undefined {
        const { occurrence, target } = buffered;
        if (target !== undefined && target !== ctx.subscriptionId) return undefined;
        const { match, transform } = entry.definition;
        try {
            if (target === undefined && match !== undefined && !match(ctx, occurrence, args)) return undefined;
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
            this.#deps.report(error);
            return undefined;
        }
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
