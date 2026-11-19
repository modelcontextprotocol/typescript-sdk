import type {
    SubscribeEventsRequestParams,
    SubscribeEventsResult,
    UnsubscribeEventsRequestParams,
    UnsubscribeEventsResult
} from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { canonicalJson, EventsError, parseWebhookSecret } from '@modelcontextprotocol/core-internal/ext/events';

import { makeContext } from './context';
import type { BufferedEvent, EmitBuffer } from './emitBuffer';
import type { SubscriptionSource } from './extension';
import { checkedSelection, selectEvent } from './poll';
import type { Batch } from './push';
import { checkedBatch, errorObject, replayBuffer, startCheck, TERMINAL_KINDS } from './push';
import type { EventRegistry, RegisteredEvent } from './registry';
import type { CheckContext, WebhookSender, WebhookSubscriptionRecord, WebhookSubscriptionStore } from './types';
import type { SubscriptionValidator, ValidSubscription } from './validation';
import { WebhookEngine } from './webhookEngine';

// The shortest TTL granted, whatever the client suggests.
const TTL_FLOOR_MS = 60_000;
// How long deliveries stay signed with the previous secret too after a rotation.
const ROTATION_GRACE_MS = 300_000;
// setTimeout fires at once for longer delays; a longer grant re-arms when the timer fires early.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const encoder = new TextEncoder();
let unwatched: AbortSignal | undefined;

// The `signal` of callbacks for a stored subscription this process does not watch; made at first use, as Cloudflare Workers refuse it at module scope.
function unwatchedSignal(): AbortSignal {
    unwatched ??= new AbortController().signal;
    return unwatched;
}

export interface WebhookDeps {
    readonly validator: SubscriptionValidator;
    readonly registry: EventRegistry;
    readonly buffer: EmitBuffer;
    readonly sender: WebhookSender;
    readonly store: WebhookSubscriptionStore;
    // Read at every subscribe and send, so origins added later count.
    readonly trustedOrigins: ReadonlySet<string>;
    // The longest TTL granted.
    readonly webhookTtlMs: number;
    readonly checkIntervalMs: number;
    report(error: unknown): void;
}

// What this process runs for a subscription whose subscribe or refresh it handled: the expiry timer, and a check type's loop.
interface Watched {
    readonly id: string;
    // The registration it serves, so onUnsubscribe pairs with it after a removal or re-registration; an update() replaces it with the updated one.
    entry: RegisteredEvent;
    // Aborts when this process stops serving the subscription; the `signal` of its callbacks.
    readonly ended: AbortController;
    readonly ctx: CheckContext;
    expiry?: ReturnType<typeof setTimeout>;
    // A check type's loop: the position checked up to, and the next check.
    position: string | null;
    checkTimer?: ReturnType<typeof setTimeout>;
}

// A subscribe request in flight for one id, from the id's derivation until it answers.
interface Subscribing {
    readonly id: string;
    readonly name: string;
    readonly principal: string;
    // Aborts when the client cancels the request.
    readonly signal: AbortSignal;
    // A termination that reached it meanwhile, which the request applies before or after its write.
    terminated?: EventsError;
}

type Queues = Map<string, Promise<unknown>>;

// Takes the termination that reached a subscribe in flight, so it is applied once.
function takeTermination(subscribing: Subscribing): EventsError | undefined {
    const { terminated } = subscribing;
    subscribing.terminated = undefined;
    return terminated;
}

// Timers never keep the process alive on their own.
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    (timer as { unref?: () => void }).unref?.();
    return timer;
}

// Runs `task` once the tasks queued before it under `key` have settled.
function enqueue<T>(queues: Queues, key: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(task);
    const settled = run.then(
        () => {},
        () => {}
    );
    queues.set(key, settled);
    void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
}

function isExpired(record: WebhookSubscriptionRecord): boolean {
    return record.expiresAt <= Date.now();
}

// No suggestion or `null` gets the cap; a suggestion is clamped up to the floor and down to the cap.
function grantMs(ttlMs: number | null | undefined, maxMs: number): number {
    return ttlMs === undefined || ttlMs === null ? maxMs : Math.min(maxMs, Math.max(TTL_FLOOR_MS, ttlMs));
}

// `sub_` and 22 base64url characters of the SHA-256 of the canonical key, with the arguments as the client sent them, so every replica and schema version derives the same id.
async function subscriptionIdOf(principal: string, url: string, name: string, rawArgs: Record<string, unknown>): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson([principal, url, name, rawArgs])));
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCodePoint(byte);
    return `sub_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').slice(0, 22)}`;
}

function notFound(): EventsError {
    return new EventsError('notFound', 'Subscription not found', { kind: 'subscription' });
}

// `events/subscribe` and `events/unsubscribe`: webhook subscriptions in the store, their expiry and check loops, the emit fan-out and termination (SEP-3415 §Webhook-Based Delivery).
export class WebhookSubscriptions implements SubscriptionSource {
    readonly #deps: WebhookDeps;
    readonly #engine: WebhookEngine;
    readonly #watched = new Map<string, Watched>();
    // Subscribe, unsubscribe and expiry of one subscription run one at a time in this process; termination does not queue, so a hook that terminates never waits on itself.
    readonly #byId: Queues = new Map();
    // Subscribes in flight: a termination that reaches one is applied by it, never stored over. Replicas can still race: the store has no compare-and-set (§5.9).
    readonly #subscribing = new Set<Subscribing>();
    // Creates past the quota check that have no watch yet.
    readonly #starting = new Set<Subscribing>();
    // The fan-out of one event type runs one emit at a time, so each subscription's deliveries reach the engine in position order.
    readonly #byName: Queues = new Map();

    constructor(deps: WebhookDeps) {
        this.#deps = deps;
        this.#engine = new WebhookEngine({
            sender: deps.sender,
            store: deps.store,
            trustedOrigins: deps.trustedOrigins,
            onerror: error => deps.report(error)
        });
    }

    // What `maxSubscriptions` counts here: the subscriptions this process watches, and the creates still starting.
    get size(): number {
        return this.#watched.size + this.#starting.size;
    }

    // Those of them `principal` holds.
    countOf(principal: string | null): number {
        let count = 0;
        for (const watched of this.#watched.values()) if (watched.ctx.principal === principal) count += 1;
        for (const subscribing of this.#starting) if (subscribing.principal === principal) count += 1;
        return count;
    }

    // Subscriptions this process watches (an expiry timer each), after handling their subscribe or refresh.
    get watching(): number {
        return this.#watched.size;
    }

    // Subscriptions this process holds delivery state for.
    get delivering(): number {
        return this.#engine.size;
    }

    async subscribe(params: SubscribeEventsRequestParams, ctx: ServerContext): Promise<SubscribeEventsResult> {
        const { url, secret } = params.delivery;
        const valid = await this.#deps.validator.validate('webhook', params, ctx, () => {
            this.#assertCallback(url);
            if (parseWebhookSecret(secret) === undefined) {
                throw new EventsError('invalidParams', 'delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes');
            }
        });
        // validate('webhook', …) refuses a request without a principal.
        const id = await subscriptionIdOf(valid.principal!, url, valid.entry.name, params.arguments ?? {});
        const ttl = grantMs(params.ttlMs, this.#deps.webhookTtlMs);
        const subscribing: Subscribing = { id, name: valid.entry.name, principal: valid.principal!, signal: ctx.mcpReq.signal };
        this.#subscribing.add(subscribing);
        try {
            return await enqueue(this.#byId, id, async () => {
                const existing = await this.#unexpired(id);
                return existing === undefined
                    ? this.#create(id, valid, params, ttl, subscribing)
                    : this.#refresh(existing, valid.entry, params, ttl, subscribing);
            });
        } finally {
            this.#subscribing.delete(subscribing);
            // A termination this request did not apply, because it failed or answered first, is applied now.
            const left = takeTermination(subscribing);
            if (left !== undefined) await this.#end(id, subscribing.name, left).catch((error: unknown) => this.#deps.report(error));
        }
    }

    async unsubscribe(params: UnsubscribeEventsRequestParams, ctx: ServerContext): Promise<UnsubscribeEventsResult> {
        const { entry, principal } = await this.#deps.validator.validate('webhook', params, ctx);
        const id = await subscriptionIdOf(principal!, params.delivery.url, entry.name, params.arguments ?? {});
        return enqueue(this.#byId, id, async () => {
            const record = await this.#unexpired(id);
            if (record === undefined || !(await this.#deps.store.delete(id))) throw notFound();
            const watched = this.#watched.get(id);
            this.#release(id);
            await this.#unsubscribed(record, watched);
            return {};
        });
    }

    // Hands an emitted event to the engine for each matching stored subscription, after the earlier emits of its type; it never waits on a receiver.
    fanOut(name: string, buffered: BufferedEvent, { cursor, previous }: { cursor: string; previous: string }): void {
        const entry = this.#deps.registry.get(name);
        if (entry === undefined) return;
        enqueue(this.#byName, name, () => this.#deliverEmitted(entry, buffered, cursor, previous)).catch((error: unknown) =>
            this.#deps.report(error)
        );
    }

    // Moves the watches of `previous` to its updated registration, so their next check parses with its schemas.
    update(previous: RegisteredEvent, next: RegisteredEvent): void {
        for (const watched of this.#watched.values()) if (watched.entry === previous) watched.entry = next;
    }

    // Sends a `terminated` envelope to each matching subscription in the store, deletes it and runs onUnsubscribe.
    async terminate(name: string, error: EventsError, subscriptionId?: string): Promise<void> {
        const ids = new Set<string>();
        if (subscriptionId === undefined) {
            for await (const record of this.#deps.store.listByName(name)) ids.add(record.id);
            // Subscribes still in flight end too, as push ends the streams still starting.
            for (const subscribing of this.#subscribing) if (subscribing.name === name) ids.add(subscribing.id);
        } else {
            ids.add(subscriptionId);
        }
        await Promise.all([...ids].map(id => this.#end(id, name, error)));
    }

    // Drops what this process holds, without onUnsubscribe, as a process restart would; the store keeps its records.
    clear(): void {
        for (const watched of this.#watched.values()) this.#stop(watched);
        this.#watched.clear();
        this.#subscribing.clear();
        this.#starting.clear();
        this.#engine.clear();
    }

    // An absolute `https` URL, or one whose exact origin is trusted.
    #assertCallback(url: string): void {
        let parsed: URL | undefined;
        try {
            parsed = new URL(url);
        } catch {
            parsed = undefined;
        }
        if (parsed !== undefined && (parsed.protocol === 'https:' || this.#deps.trustedOrigins.has(parsed.origin))) return;
        throw new EventsError('invalidParams', 'delivery.url must be an absolute https URL, or one whose origin is in trustedOrigins');
    }

    // Quota, verification and onSubscribe, then the start position, tracked before the record is stored; a termination meanwhile fails it.
    async #create(
        id: string,
        valid: ValidSubscription,
        params: SubscribeEventsRequestParams,
        ttl: number,
        subscribing: Subscribing
    ): Promise<SubscribeEventsResult> {
        const { entry, args } = valid;
        const principal = valid.principal!;
        const { url, secret } = params.delivery;
        // A watch left over here belongs to a subscription that ended elsewhere: its record is gone.
        this.#release(id);
        this.#deps.validator.assertCapacity(principal);
        // Counted from the quota check on, so concurrent creates cannot all pass it; the watch takes the count over in one step.
        this.#starting.add(subscribing);
        try {
            await this.#engine.verify(principal, url, secret, id, subscribing.signal);
            const watched = this.#watch(id, entry, principal);
            try {
                await entry.definition.onSubscribe?.(watched.ctx, args);
            } catch (error) {
                watched.ended.abort();
                this.#engine.forget(id);
                throw error;
            }
            const from = params.cursor ?? null;
            const now = Date.now();
            const record: WebhookSubscriptionRecord = {
                id,
                principal,
                name: entry.name,
                arguments: args,
                url,
                secret,
                expiresAt: now + ttl,
                createdAt: now
            };
            let start: Batch;
            try {
                start =
                    entry.kind === 'check'
                        ? await this.#startCheck(record, watched, from, params.maxAgeMs, subscribing)
                        : await this.#startEmitOnly(record, watched, from, params.maxAgeMs, subscribing);
                const terminated = takeTermination(subscribing);
                if (terminated !== undefined) {
                    await this.#deps.store.delete(id);
                    throw terminated;
                }
            } catch (error) {
                watched.ended.abort();
                this.#engine.forget(id);
                await this.#unsubscribed(record, watched);
                throw error;
            }
            this.#watched.set(id, watched);
            this.#arm(watched, record.expiresAt);
            this.#send(record, start, start.cursor);
            if (entry.kind === 'check') {
                watched.position = start.position;
                this.#schedule(watched);
            }
            return { id, refreshBefore: new Date(record.expiresAt).toISOString(), cursor: start.cursor, truncated: start.truncated };
        } finally {
            this.#starting.delete(subscribing);
        }
    }

    async #startCheck(
        record: WebhookSubscriptionRecord,
        watched: Watched,
        from: string | null,
        maxAgeMs: number | undefined,
        subscribing: Subscribing
    ): Promise<Batch> {
        const start = await startCheck(watched.entry, watched.ctx, record.arguments, from, maxAgeMs, this.#deps.report);
        const terminated = takeTermination(subscribing);
        if (terminated !== undefined) throw terminated;
        this.#engine.track(record.id, start.cursor);
        await this.#deps.store.put(record);
        return start;
    }

    // Reads the replay as it queues behind the fan-out, so an emit is either replayed or finds the stored record; the replay reaches the engine before the next fan-out.
    #startEmitOnly(
        record: WebhookSubscriptionRecord,
        watched: Watched,
        from: string | null,
        maxAgeMs: number | undefined,
        subscribing: Subscribing
    ): Promise<Batch> {
        const { buffer, report } = this.#deps;
        const replay = replayBuffer(buffer, watched.entry, watched.ctx, record.arguments, from, maxAgeMs, report);
        return enqueue(this.#byName, record.name, async () => {
            const terminated = takeTermination(subscribing);
            if (terminated !== undefined) throw terminated;
            this.#engine.track(record.id, replay.cursor);
            await this.#deps.store.put(record);
            const checked = await Promise.all(replay.events.map(event => checkedSelection(watched.entry, event, report)));
            for (const event of checked) if (event !== undefined) this.#engine.deliver(record, event, event.cursor ?? null, replay.cursor);
            return { ...replay, events: [] };
        });
    }

    // A new grant and a rotated secret; the client's cursor seeds the watermark only where this process tracks none.
    async #refresh(
        record: WebhookSubscriptionRecord,
        entry: RegisteredEvent,
        params: SubscribeEventsRequestParams,
        ttl: number,
        subscribing: Subscribing
    ): Promise<SubscribeEventsResult> {
        const { id } = record;
        const now = Date.now();
        const { secret } = params.delivery;
        const rotated =
            secret === record.secret ? {} : { secret, previousSecret: { secret: record.secret, expiresAt: now + ROTATION_GRACE_MS } };
        const refreshed: WebhookSubscriptionRecord = { ...record, ...rotated, expiresAt: now + ttl };
        await this.#endIfTerminated(subscribing, record);
        await this.#deps.store.put(refreshed);
        await this.#endIfTerminated(subscribing, refreshed);
        // Read before resume(), so a suspension shows as `active: false` on the refresh that ends it.
        const deliveryStatus = this.#engine.status(id);
        const from = params.cursor ?? null;
        if (this.#engine.watermark(id) === undefined) this.#engine.track(id, from);
        this.#engine.resume(id);
        this.#keep(refreshed, entry, from);
        return {
            id,
            refreshBefore: new Date(refreshed.expiresAt).toISOString(),
            cursor: this.#engine.watermark(id) ?? null,
            truncated: false,
            ...(deliveryStatus === undefined ? {} : { deliveryStatus })
        };
    }

    // Re-arms a refreshed subscription's timer, or starts watching it here (a check type's loop from `from`) when this process had not.
    #keep(record: WebhookSubscriptionRecord, entry: RegisteredEvent, from: string | null): void {
        let watched = this.#watched.get(record.id);
        if (watched === undefined) {
            watched = this.#watch(record.id, entry, record.principal);
            watched.position = from;
            this.#watched.set(record.id, watched);
            if (entry.kind === 'check') this.#schedule(watched);
        }
        this.#arm(watched, record.expiresAt);
    }

    #watch(id: string, entry: RegisteredEvent, principal: string): Watched {
        const ended = new AbortController();
        const ctx = makeContext({ name: entry.name, subscriptionId: id, principal, mode: 'webhook', signal: ended.signal });
        return { id, entry, ended, ctx, position: null };
    }

    #arm(watched: Watched, expiresAt: number): void {
        clearTimeout(watched.expiry);
        const delay = Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_DELAY_MS);
        watched.expiry = unref(setTimeout(() => this.#later(watched.id, () => this.#recheck(watched.id)), delay));
    }

    // Queues a task for one subscription off the caller's path; a failure goes to onerror.
    #later(id: string, task: () => Promise<void>): void {
        enqueue(this.#byId, id, task).catch((error: unknown) => this.#deps.report(error));
    }

    // The stored record, after expiring it if its grant passed.
    async #unexpired(id: string): Promise<WebhookSubscriptionRecord | undefined> {
        const record = await this.#deps.store.get(id);
        if (record === undefined || !isExpired(record)) return record;
        await this.#expire(record);
        return undefined;
    }

    // Reads the record again: gone ends what this process runs for it, a later expiry re-arms the timer, a passed one expires it.
    async #recheck(id: string): Promise<void> {
        const record = await this.#deps.store.get(id);
        if (record === undefined) {
            this.#release(id);
            return;
        }
        if (isExpired(record)) {
            await this.#expire(record);
            return;
        }
        const watched = this.#watched.get(id);
        if (watched !== undefined) this.#arm(watched, record.expiresAt);
    }

    // onUnsubscribe runs only after a delete that removed the record, so once per subscription.
    async #expire(record: WebhookSubscriptionRecord): Promise<void> {
        const deleted = await this.#deps.store.delete(record.id);
        const watched = this.#watched.get(record.id);
        this.#release(record.id);
        if (deleted) await this.#unsubscribed(record, watched);
    }

    // Ends one subscription of event type `name` with `error`: delete, a `terminated` envelope, onUnsubscribe.
    async #end(id: string, name: string, error: EventsError): Promise<void> {
        // A subscribe in flight for it applies the termination itself, so it never stores what this ended.
        let deferred = false;
        for (const subscribing of this.#subscribing) {
            if (subscribing.id !== id || subscribing.name !== name) continue;
            subscribing.terminated ??= error;
            deferred = true;
        }
        if (deferred) return;
        const record = await this.#deps.store.get(id);
        if (record?.name !== name) return;
        if (isExpired(record)) {
            await this.#expire(record);
            return;
        }
        await this.#endStored(record, error);
    }

    // A termination that reached this refresh ends `record`, and the refresh answers with its error.
    async #endIfTerminated(subscribing: Subscribing, record: WebhookSubscriptionRecord): Promise<void> {
        const terminated = takeTermination(subscribing);
        if (terminated === undefined) return;
        await this.#endStored(record, terminated);
        throw terminated;
    }

    // Only the process whose delete removed the record sends the envelope and runs onUnsubscribe.
    async #endStored(record: WebhookSubscriptionRecord, error: EventsError): Promise<void> {
        if (!(await this.#deps.store.delete(record.id))) return;
        const watched = this.#watched.get(record.id);
        // Forget first: forget() stops the control bodies queued before it.
        this.#release(record.id);
        void this.#engine.sendControl(record, { type: 'terminated', error: errorObject(error) });
        await this.#unsubscribed(record, watched);
    }

    // Stops what this process runs for the subscription and drops its delivery state.
    #release(id: string): void {
        const watched = this.#watched.get(id);
        if (watched !== undefined) {
            this.#watched.delete(id);
            this.#stop(watched);
        }
        this.#engine.forget(id);
    }

    #stop(watched: Watched): void {
        watched.ended.abort();
        clearTimeout(watched.expiry);
        clearTimeout(watched.checkTimer);
    }

    async #unsubscribed(record: WebhookSubscriptionRecord, watched: Watched | undefined): Promise<void> {
        const entry = watched?.entry ?? this.#deps.registry.get(record.name);
        const ctx = watched?.ctx ?? this.#contextOf(record, AbortSignal.abort());
        try {
            await entry?.definition.onUnsubscribe?.(ctx, record.arguments);
        } catch (error) {
            this.#deps.report(error);
        }
    }

    #contextOf(record: WebhookSubscriptionRecord, signal: AbortSignal): CheckContext {
        return makeContext({ name: record.name, subscriptionId: record.id, principal: record.principal, mode: 'webhook', signal });
    }

    async #deliverEmitted(entry: RegisteredEvent, buffered: BufferedEvent, cursor: string, previous: string): Promise<void> {
        for await (const record of this.#recordsFor(entry.name, buffered.target)) {
            if (isExpired(record)) {
                this.#later(record.id, () => this.#recheck(record.id));
                continue;
            }
            const ctx = this.#watched.get(record.id)?.ctx ?? this.#contextOf(record, unwatchedSignal());
            const selected = selectEvent(entry, ctx, record.arguments, buffered, this.#deps.report);
            const occurrence = selected === undefined ? undefined : await checkedSelection(entry, selected, this.#deps.report);
            if (occurrence !== undefined) this.#engine.deliver(record, occurrence, cursor, previous);
        }
    }

    // Every stored subscription of the type, or only the target of a targeted emit.
    async *#recordsFor(name: string, target: string | undefined): AsyncIterable<WebhookSubscriptionRecord> {
        if (target === undefined) {
            yield* this.#deps.store.listByName(name);
            return;
        }
        const record = await this.#deps.store.get(target);
        if (record?.name === name) yield record;
    }

    #send(record: WebhookSubscriptionRecord, batch: Batch, seed: string | null): void {
        for (const event of batch.events) this.#engine.deliver(record, event, event.cursor ?? null, seed);
    }

    #schedule(watched: Watched): void {
        watched.checkTimer = unref(setTimeout(() => void this.#check(watched), this.#deps.checkIntervalMs));
    }

    // One run of a check type's loop: the events since the last run, and a `gap` envelope for a truncated result.
    async #check(watched: Watched): Promise<void> {
        const { id, entry } = watched;
        const from = watched.position;
        try {
            const record = await this.#deps.store.get(id);
            if (this.#watched.get(id) !== watched) return;
            if (record === undefined || isExpired(record)) {
                // The expiry path decides; it stops this loop unless the record was refreshed meanwhile.
                this.#later(id, () => this.#recheck(id));
            } else {
                const result = await entry.definition.check!(watched.ctx, record.arguments, from);
                const batch = await checkedBatch(entry, from, result, undefined, this.#deps.report);
                if (this.#watched.get(id) !== watched) return;
                if (batch.truncated) void this.#engine.sendControl(record, { type: 'gap', cursor: batch.cursor });
                this.#send(record, batch, from);
                // A quiet batch moves the watermark to the upstream cursor once nothing awaits an answer, so the refresh cursor advances.
                if (batch.events.length === 0) this.#engine.advance(id, batch.position);
                watched.position = batch.position;
            }
        } catch (error) {
            if (this.#watched.get(id) !== watched) return;
            if (error instanceof EventsError && TERMINAL_KINDS.has(error.kind)) {
                this.#end(id, entry.name, error).catch((error_: unknown) => this.#deps.report(error_));
                return;
            }
            this.#deps.report(error);
        }
        this.#schedule(watched);
    }
}
