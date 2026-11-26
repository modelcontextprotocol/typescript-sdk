import type { DeliveryErrorCategory, DeliveryStatus, EventOccurrence, WebhookControlBody } from '@modelcontextprotocol/core/ext/events';
import { WEBHOOK_SUBSCRIPTION_ID_HEADER } from '@modelcontextprotocol/core/ext/events';
import {
    EventsError,
    generateWebhookId,
    parseWebhookSecret,
    signWebhook,
    timingSafeEqualString
} from '@modelcontextprotocol/core-internal/ext/events';

import type { WebhookSender, WebhookSendOutcome, WebhookSubscriptionRecord, WebhookSubscriptionStore } from './types';

// The waits between the five attempts of one message; after the last it is abandoned.
const RETRY_DELAYS_MS = [5000, 30_000, 120_000, 300_000];
// Non-2xx answers that end a message without a retry.
const FINAL_STATUSES: ReadonlySet<number> = new Set([410, 413]);
const MAX_BODY_BYTES = 262_144;
// The most messages of one subscription waiting for a slot or parked, together: as many as the emit buffer holds by default.
export const MAX_HELD_MESSAGES = 10_000;
// The most event POSTs of one subscription in flight at once.
const MAX_IN_FLIGHT_PER_SUBSCRIPTION = 10;
// Abandoned events are reported at once, then counted and reported together at most this often per subscription.
const ABANDON_REPORT_INTERVAL_MS = 60_000;
// Delivery is suspended once more than 95 % of at least 100 attempts in the last 60 minutes failed, counted per minute.
const SUSPENSION_WINDOW_MINUTES = 60;
const MINUTE_MS = 60_000;
const SUSPENSION_MIN_ATTEMPTS = 100;
const SUSPENSION_FAILURE_PERCENT = 95;
// A failed verification of a (principal, url) is answered again for this long without a POST.
const FAILED_VERIFICATION_MS = 60_000;
// Verification POSTs to one destination host: one at a time, and at most 10 in any 60 s; at most 10 more wait their turn. One principal holds at most 3 of these at once, sending or waiting, and gets no more there once 3 of its verifications to the host failed in the window, until it moves.
const VERIFICATIONS_PER_WINDOW = 10;
const PRINCIPAL_VERIFICATIONS_AT_ONCE = 3;
const PRINCIPAL_FAILURES_PER_WINDOW = 3;
const VERIFICATION_WINDOW_MS = 60_000;
// The retry hint when the host's wait is full or the principal holds its three places there: nodeWebhookSender's 5 s timeout, by when the verification in flight has ended.
const QUEUE_FULL_RETRY_MS = 5000;
// The most failed pairs, destination hosts and principals' failures at a host the verification limits remember.
const MAX_REMEMBERED = 10_000;
// setTimeout fires at once for longer delays; a longer grant re-arms when the timer fires early.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
// After a failed store read, the record of an unwatched subscription is read again this much later.
const SWEEP_RETRY_MS = 60_000;

const encoder = new TextEncoder();

export interface WebhookEngineOptions {
    readonly sender: WebhookSender;
    readonly store: WebhookSubscriptionStore;
    // Read at every send, so origins added later count.
    readonly trustedOrigins: ReadonlySet<string>;
    onerror(error: Error): void;
    // Whether this process watches the subscription (an expiry timer of its own); default none.
    readonly watches?: (id: string) => boolean;
    readonly now?: () => number;
}

// Where a message is: waiting for a slot, holding one while an attempt is in flight, waiting for its retry, parked while delivery is suspended, or acknowledged or abandoned.
type Place = 'waiting' | 'running' | 'retrying' | 'parked' | 'done';

// One event POST to one subscription, under one webhook-id until it is acknowledged or abandoned.
interface Message {
    readonly webhookId: string;
    readonly occurrence: EventOccurrence;
    // The subscription's position after this event.
    readonly position: string | null;
    attempts: number;
    place: Place;
    retry?: ReturnType<typeof setTimeout>;
}

// One control body to one subscription, under one webhook-id until it is answered or abandoned; it never touches the watermark.
interface Control {
    readonly record: WebhookSubscriptionRecord;
    readonly webhookId: string;
    // The body of each attempt.
    body: () => WebhookControlBody;
    // A gap body: no attempt starts while one of the subscription's event POSTs is in flight.
    readonly idleOnly: boolean;
    // Aborts its send in flight once it is stopped.
    readonly ended: AbortController;
    attempts: number;
    last?: WebhookSendOutcome;
    retry?: ReturnType<typeof setTimeout>;
    readonly resolve: (outcome: WebhookSendOutcome | undefined) => void;
}

// The attempts of one minute of the suspension window, and how many of them failed.
interface MinuteCount {
    readonly minute: number;
    attempts: number;
    failures: number;
}

// What this process holds for one subscription it delivers to.
interface Tracked {
    readonly id: string;
    // Aborts the subscription's sends in flight once it is forgotten.
    readonly ended: AbortController;
    // Every event at or before this position is acknowledged or abandoned.
    watermark: string | null;
    // Messages not yet acknowledged or abandoned, in position order.
    readonly pending: Message[];
    // How many messages hold a slot, and the messages waiting for one: first attempts in position order, each retry once it is due.
    running: number;
    waiting: Message[];
    // Messages that came due while delivery was suspended, oldest first.
    parked: Message[];
    active: boolean;
    // The record's expiresAt when delivery was suspended; a later one means a refresh, on any replica, since.
    suspendedExpiresAt?: number;
    // Events abandoned since the last report and the latest of them, when that report went out, and the timer of the next.
    abandoned: number;
    lastAbandoned?: string;
    reportedAt?: number;
    report?: ReturnType<typeof setTimeout>;
    lastDeliveryAt: string | null;
    lastError: DeliveryErrorCategory | null;
    // The first failure since the last acknowledgement.
    failedSince?: string;
    // The attempts of the last SUSPENSION_WINDOW_MINUTES minutes, one count per minute that had any, oldest first.
    window: MinuteCount[];
    // For a subscription this process does not watch: the `createdAt` of the record it delivers to, and the next read of that record.
    createdAt?: number;
    sweep?: ReturnType<typeof setTimeout>;
    // Marks of events lost to the subscriber, as a running total, and the total the subscriber has been told of; an acknowledged gap envelope tells it of the marks made before its body was built.
    marked: number;
    told: number;
    // The watermark the last `truncated: true` refresh answer carried, since the last mark, and whether that refresh carried another cursor: only then does a refresh with it show the answer arrived.
    answered?: { readonly cursor: string | null; readonly proves: boolean };
    // The mark made when this process began delivering to a subscription created before it started (a process before it may have held undelivered events); told once `told` reaches it.
    restart?: number;
    // A gap envelope is in flight.
    signalling: boolean;
    // A position advance() asked for while messages were pending; the watermark moves to it once none is, unless a later delivery came first.
    advanceTo?: { readonly position: string | null };
    // Gap attempts waiting for the event POSTs in flight to settle.
    idle: Array<() => void>;
    // Callers waiting for every message to settle (whenIdle).
    drained: Array<() => void>;
}

// One `principal\0url` handshake in flight: the subscribes waiting for it, and the abort that pulls it from the host's queue once all of them were cancelled.
interface Handshake {
    readonly done: Promise<void>;
    readonly abandoned: AbortController;
    callers: number;
}

// One destination host's verification POSTs: the principal whose verification holds the slot, the verifications waiting for it (oldest first) with their principals, and the send times of the last window, oldest first.
interface HostVerifications {
    holder: string | undefined;
    readonly waiting: Array<{ readonly principal: string; resolve(): void; reject(error: unknown): void }>;
    readonly sent: number[];
}

// `times` (oldest first) without those at or before `start`, which it drops from its front.
function since(times: number[], start: number): number[] {
    while (times[0] !== undefined && times[0] <= start) times.shift();
    return times;
}

// The key of one principal's verifications to the lower-cased destination hostname of `url`.
function hostKeyOf(principal: string, url: string): string {
    return `${principal}\u0000${new URL(url).hostname.toLowerCase()}`;
}

// Adds `key` to `map`, first dropping the entries `stale` says are done from its front, where the oldest are; at MAX_REMEMBERED it drops every such entry, then the oldest.
function remember<V>(map: Map<string, V>, key: string, value: V, stale: (held: V) => boolean): void {
    map.delete(key);
    for (const [held, entry] of map) {
        if (!stale(entry)) break;
        map.delete(held);
    }
    if (map.size >= MAX_REMEMBERED) {
        for (const [held, entry] of map) if (stale(entry)) map.delete(held);
        if (map.size >= MAX_REMEMBERED) map.delete(map.keys().next().value!);
    }
    map.set(key, value);
}

// Retry timers never keep the process alive on their own.
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
    (timer as { unref?: () => void }).unref?.();
    return timer;
}

function byteLength(text: string): number {
    return encoder.encode(text).byteLength;
}

function isSuccess(status: number): boolean {
    return status >= 200 && status < 300;
}

function isRetryable(outcome: WebhookSendOutcome): boolean {
    return 'error' in outcome || (!isSuccess(outcome.status) && !FINAL_STATUSES.has(outcome.status));
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

// The bytes of a `whsec_` secret; records and subscribe requests carry only valid ones.
function signingKey(secret: string): Uint8Array {
    const key = parseWebhookSecret(secret);
    if (key === undefined) throw new TypeError('a webhook secret is not a Standard Webhooks secret (whsec_ and base64 of 24 to 64 bytes)');
    return key;
}

// A single-use verification challenge: base64url of 32 random bytes.
function challengeNonce(): string {
    let binary = '';
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCodePoint(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Whether a verification answer is a 2xx whose JSON body echoes the challenge.
function echoes(outcome: { status: number; body: string }, challenge: string): boolean {
    if (!isSuccess(outcome.status)) return false;
    let echoed: unknown;
    try {
        echoed = (JSON.parse(outcome.body) as { challenge?: unknown } | null)?.challenge;
    } catch {
        return false;
    }
    return typeof echoed === 'string' && timingSafeEqualString(echoed, challenge);
}

function verificationError(reason: DeliveryErrorCategory): EventsError {
    return new EventsError('callbackEndpointError', `Webhook endpoint verification failed: ${reason}`, { reason });
}

// Settles as `promise` does, or rejects with its reason once `signal` aborts.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        if (signal.aborted) abort();
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function verificationLimit(retryAfterMs: number): EventsError {
    return new EventsError('resourceExhausted', 'Too many webhook endpoint verifications for this host', {
        limit: 'verification',
        retryAfterMs
    });
}

// Sends webhook POSTs: endpoint verification, signed event deliveries with per-message retries and the watermark cursor, and control bodies.
export class WebhookEngine {
    readonly #sender: WebhookSender;
    readonly #store: WebhookSubscriptionStore;
    readonly #trustedOrigins: ReadonlySet<string>;
    readonly #onerror: (error: Error) => void;
    readonly #watches: (id: string) => boolean;
    readonly #now: () => number;
    readonly #tracked = new Map<string, Tracked>();
    readonly #controls = new Set<Control>();
    // Each verified `principal\0url` with the subscription ids it covers; it lasts while one of them does.
    readonly #verified = new Map<string, Set<string>>();
    readonly #verifiedKeyOf = new Map<string, string>();
    // Each `principal\0url` handshake in flight, which another subscribe of the pair waits for.
    readonly #handshakes = new Map<string, Handshake>();
    // Each `principal\0url` whose verification failed lately: the failure, and until when it is answered without a POST.
    readonly #failed = new Map<string, { readonly reason: DeliveryErrorCategory; readonly until: number }>();
    // By lower-cased destination hostname (SEP-3415: rate-limited per destination host).
    readonly #hosts = new Map<string, HostVerifications>();
    // By `principal\0hostname`: when the principal's verifications to the host failed in the last window, oldest first.
    readonly #hostFailures = new Map<string, number[]>();
    // Aborts verification sends in flight on clear(); made at first use, as Cloudflare Workers refuse it at module scope.
    #lifetime: AbortController | undefined;
    // When this engine started, or clear() started it again as a restart would; a reading of 0 waits for the first use, as deployed Cloudflare Workers read 0 from the clock at module scope.
    #startedAt: number | undefined;

    constructor(options: WebhookEngineOptions) {
        this.#sender = options.sender;
        this.#store = options.store;
        this.#trustedOrigins = options.trustedOrigins;
        this.#onerror = options.onerror;
        this.#watches = options.watches ?? (() => false);
        this.#now = options.now ?? (() => Date.now());
        this.#startedAt = this.#now() || undefined;
    }

    // Subscriptions this process holds delivery state for.
    get size(): number {
        return this.#tracked.size;
    }

    // The failed pairs, destination hosts and principals' failures at a host the verification limits hold.
    get remembered(): { readonly failed: number; readonly hosts: number; readonly hostFailures: number } {
        return { failed: this.#failed.size, hosts: this.#hosts.size, hostFailures: this.#hostFailures.size };
    }

    // The per-minute counts the suspension windows hold, across subscriptions: at most SUSPENSION_WINDOW_MINUTES each.
    get windowMinutes(): number {
        let minutes = 0;
        for (const tracked of this.#tracked.values()) minutes += tracked.window.length;
        return minutes;
    }

    // One attempt, which the subscribe call waits for, after the host's verification in flight; throws `callbackEndpointError` with the failure category as `data.reason`, or `resourceExhausted` at the host's limit or once the principal's verifications to the host failed too often.
    async verify(principal: string, url: string, secret: string, subscriptionId: string, signal?: AbortSignal): Promise<void> {
        this.#use();
        const key = `${principal}\u0000${url}`;
        if (!this.#verified.has(key)) await this.#verifyPair(principal, key, url, secret, subscriptionId, signal);
        let covered = this.#verified.get(key);
        if (covered === undefined) {
            covered = new Set();
            this.#verified.set(key, covered);
        }
        covered.add(subscriptionId);
        this.#verifiedKeyOf.set(subscriptionId, key);
    }

    // Starts the subscription's watermark at `startCursor`, dropping whatever this process held for it.
    track(id: string, startCursor: string | null): void {
        this.#use();
        this.#drop(id);
        this.#start(id, startCursor);
    }

    // Queues one event POST and returns; calls for one subscription come in position order, and `seed` starts the watermark of an untracked id.
    deliver(record: WebhookSubscriptionRecord, occurrence: EventOccurrence, position: string | null, seed: string | null): void {
        this.#use();
        const tracked = this.#trackedFor(record, seed);
        tracked.advanceTo = undefined;
        const message: Message = { webhookId: generateWebhookId(), occurrence, position, attempts: 0, place: 'waiting' };
        tracked.pending.push(message);
        this.#queue(tracked, message, record);
    }

    // Marks events lost before they reached this engine (a fan-out past its cap); `seed` starts the watermark of an untracked id.
    markGap(record: WebhookSubscriptionRecord, seed: string | null): void {
        this.#use();
        this.#mark(this.#trackedFor(record, seed));
    }

    // Queues a control body, retried like an event, and resolves with its last answer (`undefined` without one); request paths must not await it.
    sendControl(record: WebhookSubscriptionRecord, body: WebhookControlBody): Promise<WebhookSendOutcome | undefined> {
        this.#use();
        return this.#queueControl(record, body.type, () => body, false);
    }

    // Marks a loss the caller found (a truncated `check` page; `seed` starts the watermark of an untracked id) and sends its `gap` body at once, as one goes after an acknowledged delivery: the mark stays until the subscriber is told.
    sendGap(record: WebhookSubscriptionRecord, seed: string | null): void {
        this.#use();
        const tracked = this.#trackedFor(record, seed);
        this.#mark(tracked);
        this.#signalGap(tracked, record);
    }

    watermark(id: string): string | null | undefined {
        this.#use();
        return this.#tracked.get(id)?.watermark;
    }

    // Whether a refresh with `cursor` answers `truncated: true`: every refresh does while events lost since the subscriber was last told are marked, until one carries the watermark such an answer carried to a refresh with another cursor.
    answerGap(id: string, cursor: string | null): boolean {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked === undefined || tracked.told === tracked.marked) return false;
        const { answered, watermark } = tracked;
        // A type without replay has no position to have skipped past (SEP-3415: `truncated` stays false).
        if (watermark === null || (answered?.proves === true && cursor === answered.cursor)) {
            this.#told(tracked, tracked.marked);
            return false;
        }
        // A refresh that already carried the watermark cannot tell a lost answer from a received one, so only a gap envelope clears the mark then.
        tracked.answered = { cursor: watermark, proves: cursor !== watermark };
        return true;
    }

    // A refresh answered `truncated: true` at the watermark, which tells the subscriber of every loss marked so far.
    gapAnswered(id: string): void {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked !== undefined) this.#told(tracked, tracked.marked);
    }

    // Whether the subscriber was already told of the gap this process marked as it began delivering to a subscription created before it started.
    restartTold(id: string): boolean {
        this.#use();
        const tracked = this.#tracked.get(id);
        return tracked?.restart !== undefined && tracked.told >= tracked.restart;
    }

    // Moves the watermark to `position`, at once or once the pending messages settle, so a quiet upstream or a skipped event still advances it; it never passes an unsettled message, and starts no state for an untracked id.
    advance(id: string, position: string | null): void {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) return;
        if (tracked.pending.length === 0) tracked.watermark = position;
        else tracked.advanceTo = { position };
    }

    // Calls `listener` once no message of the subscription awaits an answer: at once when none does or the id is untracked, and on a drop.
    whenIdle(id: string, listener: () => void): void {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked === undefined || tracked.pending.length === 0) listener();
        else tracked.drained.push(listener);
    }

    status(id: string): DeliveryStatus | undefined {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) return undefined;
        const { active, lastDeliveryAt, lastError, failedSince } = tracked;
        return failedSince === undefined ? { active, lastDeliveryAt, lastError } : { active, lastDeliveryAt, lastError, failedSince };
    }

    // Reactivates a suspended subscription and retries the messages that waited, in position order as slots free.
    resume(id: string): void {
        this.#use();
        const tracked = this.#tracked.get(id);
        if (tracked === undefined || tracked.active) return;
        tracked.active = true;
        tracked.suspendedExpiresAt = undefined;
        tracked.window = [];
        const parked = new Set(tracked.parked);
        tracked.parked = [];
        // Parked messages go first, in position order.
        const resumed = tracked.pending.filter(message => parked.has(message));
        for (const message of resumed) message.place = 'waiting';
        tracked.waiting = [...resumed, ...tracked.waiting];
        this.#fill(tracked);
    }

    // Drops the subscription's delivery state and stops its control bodies; its last subscription also drops a (principal, url) verification.
    forget(id: string): void {
        this.#use();
        this.#drop(id);
        for (const control of this.#controls) if (control.record.id === id) this.#stopControl(control);
        const key = this.#verifiedKeyOf.get(id);
        if (key === undefined) return;
        this.#verifiedKeyOf.delete(id);
        const covered = this.#verified.get(key);
        if (covered === undefined) return;
        covered.delete(id);
        if (covered.size === 0) this.#verified.delete(key);
    }

    // Drops all in-memory state, as a process restart would.
    clear(): void {
        for (const id of this.#tracked.keys()) this.#drop(id);
        for (const control of this.#controls) this.#stopControl(control);
        this.#verified.clear();
        this.#verifiedKeyOf.clear();
        this.#handshakes.clear();
        this.#failed.clear();
        for (const host of this.#hosts.values())
            for (const waiter of host.waiting.splice(0)) waiter.reject(verificationLimit(QUEUE_FULL_RETRY_MS));
        this.#hosts.clear();
        this.#hostFailures.clear();
        this.#lifetime?.abort();
        this.#lifetime = undefined;
        this.#startedAt = this.#now() || undefined;
    }

    // The start time, taken at the first use when the clock read 0 at construction or clear(); every public method calls it first, except clear() and the getters.
    #use(): number {
        return (this.#startedAt ??= this.#now());
    }

    // The pair's handshake in flight, or a new one; `signal` (the subscribe request's) stops this caller waiting for it.
    async #verifyPair(
        principal: string,
        key: string,
        url: string,
        secret: string,
        subscriptionId: string,
        signal: AbortSignal | undefined
    ): Promise<void> {
        let handshake = this.#handshakes.get(key);
        if (handshake === undefined) {
            const abandoned = new AbortController();
            const done = this.#handshake(principal, key, url, secret, subscriptionId, abandoned.signal).finally(() => {
                if (this.#handshakes.get(key)?.done === done) this.#handshakes.delete(key);
            });
            handshake = { done, abandoned, callers: 0 };
            this.#handshakes.set(key, handshake);
        }
        handshake.callers += 1;
        try {
            await untilAborted(handshake.done, signal);
        } finally {
            handshake.callers -= 1;
            if (handshake.callers === 0 && signal?.aborted === true) handshake.abandoned.abort(signal.reason);
        }
    }

    // One verification POST, unless a failure of the pair is still remembered, the host, the principal's places at it or its failures there are at their limit, or every subscribe waiting for it was cancelled while it queued.
    async #handshake(
        principal: string,
        key: string,
        url: string,
        secret: string,
        subscriptionId: string,
        abandoned: AbortSignal
    ): Promise<void> {
        const failed = this.#failed.get(key);
        if (failed !== undefined && this.#now() < failed.until) throw verificationError(failed.reason);
        this.#failed.delete(key);
        const hostKey = hostKeyOf(principal, url);
        const host = await this.#claimHost(principal, hostKey, url, abandoned);
        this.#lifetime ??= new AbortController();
        const { signal } = this.#lifetime;
        try {
            const challenge = challengeNonce();
            const body = JSON.stringify({ type: 'verification', challenge });
            const outcome = await this.#post(url, subscriptionId, [secret], generateWebhookId('verification'), body, signal);
            let reason: DeliveryErrorCategory | undefined;
            if ('error' in outcome) reason = outcome.error;
            else if (!echoes(outcome, challenge)) reason = 'challenge_failed';
            if (reason === undefined) return;
            // A send that clear() aborted leaves nothing behind.
            if (!signal.aborted) {
                const now = this.#now();
                remember(this.#failed, key, { reason, until: now + FAILED_VERIFICATION_MS }, held => held.until <= this.#now());
                const start = now - VERIFICATION_WINDOW_MS;
                const failures = since(this.#hostFailures.get(hostKey) ?? [], start);
                failures.push(now);
                remember(this.#hostFailures, hostKey, failures, held => (held.at(-1) ?? start) <= start);
            }
            throw verificationError(reason);
        } finally {
            this.#releaseHost(host);
        }
    }

    // Waits for the host's one verification slot, leaving the queue when `abandoned` aborts, then counts the POST; throws `resourceExhausted` with a retry hint when the wait or the window is full, the principal already holds its share of the host's places, or its verifications to the host failed too often.
    async #claimHost(principal: string, hostKey: string, url: string, abandoned: AbortSignal): Promise<HostVerifications> {
        const name = new URL(url).hostname.toLowerCase();
        const host = this.#hosts.get(name) ?? { holder: undefined, waiting: [], sent: [] };
        const windowStart = this.#now() - VERIFICATION_WINDOW_MS;
        // Remembered again at every use, so the least recently used host, the first to go stale, is at the front.
        remember(this.#hosts, name, host, held => held.holder === undefined && (held.sent.at(-1) ?? windowStart) <= windowStart);
        const refused = this.#failuresRetry(hostKey);
        if (refused !== undefined) throw verificationLimit(refused);
        const held = host.waiting.filter(waiter => waiter.principal === principal).length + (host.holder === principal ? 1 : 0);
        if (held >= PRINCIPAL_VERIFICATIONS_AT_ONCE) throw verificationLimit(QUEUE_FULL_RETRY_MS);
        if (host.holder === undefined) {
            host.holder = principal;
        } else {
            if (host.waiting.length >= VERIFICATIONS_PER_WINDOW) throw verificationLimit(QUEUE_FULL_RETRY_MS);
            await this.#waitTurn(host, principal, abandoned);
            // Handed the slot just as it was abandoned: pass it on without a POST.
            if (abandoned.aborted) {
                this.#releaseHost(host);
                throw abandoned.reason;
            }
        }
        const now = this.#now();
        const start = now - VERIFICATION_WINDOW_MS;
        const sent = since(host.sent, start);
        // Its own verifications that failed while it waited count too.
        const retryAfterMs = sent.length >= VERIFICATIONS_PER_WINDOW ? sent[0]! - start : this.#failuresRetry(hostKey);
        if (retryAfterMs !== undefined) {
            this.#releaseHost(host);
            throw verificationLimit(retryAfterMs);
        }
        sent.push(now);
        return host;
    }

    // How long until the principal may verify at the host again, once its verifications there failed PRINCIPAL_FAILURES_PER_WINDOW times in the window; `undefined` while it may.
    #failuresRetry(hostKey: string): number | undefined {
        const start = this.#now() - VERIFICATION_WINDOW_MS;
        const failures = since(this.#hostFailures.get(hostKey) ?? [], start);
        return failures.length >= PRINCIPAL_FAILURES_PER_WINDOW ? failures[0]! - start : undefined;
    }

    // Resolves holding the slot, which #releaseHost hands over; rejects at once, out of the queue, when `abandoned` aborts.
    #waitTurn(host: HostVerifications, principal: string, abandoned: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const leave = (): void => {
                const index = host.waiting.indexOf(waiter);
                if (index !== -1) host.waiting.splice(index, 1);
                reject(abandoned.reason);
            };
            const waiter = {
                principal,
                resolve: () => {
                    abandoned.removeEventListener('abort', leave);
                    resolve();
                },
                reject: (error: unknown) => {
                    abandoned.removeEventListener('abort', leave);
                    reject(error);
                }
            };
            host.waiting.push(waiter);
            abandoned.addEventListener('abort', leave, { once: true });
        });
    }

    // Hands the host's slot to the verification that waited longest, or frees it.
    #releaseHost(host: HostVerifications): void {
        const next = host.waiting.shift();
        host.holder = next?.principal;
        next?.resolve();
    }

    #start(id: string, watermark: string | null): Tracked {
        const tracked: Tracked = {
            id,
            ended: new AbortController(),
            watermark,
            pending: [],
            running: 0,
            waiting: [],
            parked: [],
            active: true,
            abandoned: 0,
            lastDeliveryAt: null,
            lastError: null,
            window: [],
            marked: 0,
            told: 0,
            signalling: false,
            idle: [],
            drained: []
        };
        this.#tracked.set(id, tracked);
        return tracked;
    }

    // The subscription's state, started at `seed` when it has none; for one this process does not watch, a record created again since starts it again, as track() does on a create, and one created before this engine started begins with a gap mark.
    #trackedFor(record: WebhookSubscriptionRecord, seed: string | null): Tracked {
        const watched = this.#watches(record.id);
        let tracked = this.#tracked.get(record.id);
        if (!watched && tracked?.createdAt !== undefined && tracked.createdAt !== record.createdAt) {
            this.#drop(record.id);
            tracked = undefined;
        }
        if (tracked !== undefined) return tracked;
        tracked = this.#start(record.id, seed);
        if (!watched) {
            tracked.createdAt = record.createdAt;
            this.#sweepAt(tracked, record);
            // The process this one replaced, or the one beside it, may have held undelivered events.
            if (record.createdAt < this.#use()) {
                this.#mark(tracked);
                tracked.restart = tracked.marked;
            }
        }
        return tracked;
    }

    // A new loss: the subscriber has to be told again, even if a refresh answer told it of earlier ones.
    #mark(tracked: Tracked): void {
        tracked.marked += 1;
        tracked.answered = undefined;
    }

    // The subscriber was told of the marks up to the running total `through`; later ones stay.
    #told(tracked: Tracked, through: number): void {
        tracked.told = Math.max(tracked.told, through);
        if (tracked.told === tracked.marked) tracked.answered = undefined;
    }

    #drop(id: string): void {
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) return;
        this.#tracked.delete(id);
        tracked.ended.abort();
        for (const message of tracked.pending) clearTimeout(message.retry);
        clearTimeout(tracked.report);
        clearTimeout(tracked.sweep);
        // Gap attempts that waited on this state try again once the caller is done, unless forget() or clear() stopped them.
        for (const attempt of tracked.idle.splice(0)) queueMicrotask(attempt);
        for (const listener of tracked.drained.splice(0)) queueMicrotask(listener);
    }

    // Reads the record of a subscription this process does not watch again at its expiry, so its state goes once the subscription ends elsewhere.
    #sweepAt(tracked: Tracked, record: WebhookSubscriptionRecord): void {
        const delay = Math.min(Math.max(record.expiresAt - this.#now(), 0), MAX_TIMER_DELAY_MS);
        tracked.sweep = unref(setTimeout(() => void this.#sweep(tracked), delay));
    }

    // A record gone, expired or created again drops the state, unless it started again since; a later expiry re-arms; a watch begun since takes over.
    async #sweep(tracked: Tracked): Promise<void> {
        tracked.sweep = undefined;
        let record: WebhookSubscriptionRecord | undefined;
        try {
            record = await this.#store.get(tracked.id);
        } catch (error) {
            if (!this.#isCurrent(tracked)) return;
            this.#onerror(toError(error));
            tracked.sweep = unref(setTimeout(() => void this.#sweep(tracked), SWEEP_RETRY_MS));
            return;
        }
        if (!this.#isCurrent(tracked) || this.#watches(tracked.id)) return;
        if (record === undefined || record.expiresAt <= this.#now() || record.createdAt !== tracked.createdAt) this.forget(tracked.id);
        else this.#sweepAt(tracked, record);
    }

    #isCurrent(tracked: Tracked): boolean {
        return this.#tracked.get(tracked.id) === tracked;
    }

    // Runs the message's next attempt in a free slot, or queues it behind the messages waiting; a message that waits reads the record when it starts.
    #queue(tracked: Tracked, message: Message, record?: WebhookSubscriptionRecord): void {
        if (tracked.running < MAX_IN_FLIGHT_PER_SUBSCRIPTION) {
            this.#begin(tracked, message, record);
            return;
        }
        message.place = 'waiting';
        tracked.waiting.push(message);
        this.#cap(tracked);
    }

    // Gives `message` a slot for one attempt.
    #begin(tracked: Tracked, message: Message, record?: WebhookSubscriptionRecord): void {
        message.place = 'running';
        tracked.running += 1;
        this.#attempt(tracked, message, record);
    }

    // Starts the messages that waited longest while a slot is free.
    #fill(tracked: Tracked): void {
        while (tracked.running < MAX_IN_FLIGHT_PER_SUBSCRIPTION) {
            const next = tracked.waiting.shift();
            if (next === undefined) return;
            this.#begin(tracked, next);
        }
    }

    // Moves the message to `place`; one whose attempt ends hands its slot to the message that waited longest.
    #release(tracked: Tracked, message: Message, place: 'retrying' | 'parked' | 'done'): void {
        const held = message.place === 'running';
        message.place = place;
        if (!held) return;
        tracked.running -= 1;
        this.#fill(tracked);
        if (tracked.running === 0) for (const attempt of tracked.idle.splice(0)) attempt();
    }

    // Past MAX_HELD_MESSAGES waiting or parked, abandons the oldest of them by position.
    #cap(tracked: Tracked): void {
        if (tracked.waiting.length + tracked.parked.length <= MAX_HELD_MESSAGES) return;
        const oldest = tracked.pending.find(message => message.place === 'waiting' || message.place === 'parked')!;
        const held = oldest.place === 'waiting' ? tracked.waiting : tracked.parked;
        held.splice(held.indexOf(oldest), 1);
        this.#abandon(tracked, oldest, `past the ${MAX_HELD_MESSAGES} messages it holds waiting or parked`);
    }

    // Settles a message the engine gives up on, and reports it at once unless a report went out in the last ABANDON_REPORT_INTERVAL_MS; then it counts towards the next.
    #abandon(tracked: Tracked, message: Message, reason: string): void {
        this.#settle(tracked, message);
        this.#mark(tracked);
        const { eventId } = message.occurrence;
        const now = this.#now();
        if (tracked.report === undefined && (tracked.reportedAt === undefined || now - tracked.reportedAt >= ABANDON_REPORT_INTERVAL_MS)) {
            tracked.reportedAt = now;
            this.#onerror(new Error(`webhook subscription ${tracked.id}: abandoned event ${eventId} ${reason}`));
            return;
        }
        tracked.abandoned += 1;
        tracked.lastAbandoned = eventId;
        tracked.report ??= unref(setTimeout(() => this.#reportAbandoned(tracked), tracked.reportedAt! + ABANDON_REPORT_INTERVAL_MS - now));
    }

    // Reports how many events were abandoned since the last report, and the latest.
    #reportAbandoned(tracked: Tracked): void {
        const { abandoned, lastAbandoned } = tracked;
        tracked.report = undefined;
        tracked.reportedAt = this.#now();
        tracked.abandoned = 0;
        this.#onerror(
            new Error(
                `webhook subscription ${tracked.id}: abandoned ${abandoned} more ${abandoned === 1 ? 'event' : 'events'} since the last report, the latest ${lastAbandoned}`
            )
        );
    }

    // Runs one attempt off the caller's path; an unexpected failure is reported and retried like a failed send.
    #attempt(tracked: Tracked, message: Message, record?: WebhookSubscriptionRecord): void {
        this.#try(tracked, message, record).catch((error: unknown) => {
            if (!this.#isCurrent(tracked)) return;
            this.#onerror(toError(error));
            this.#retry(tracked, message);
        });
    }

    async #try(tracked: Tracked, message: Message, supplied: WebhookSubscriptionRecord | undefined): Promise<void> {
        message.attempts += 1;
        // A copy that looks expired may predate a refresh, so the store's record decides.
        const fresh = supplied !== undefined && supplied.expiresAt > this.#now() ? supplied : undefined;
        const record = fresh ?? (await this.#store.get(tracked.id));
        if (!this.#isCurrent(tracked)) return;
        // A record gone from the store, or expired, ends what this process holds for the subscription.
        if (record === undefined || record.expiresAt <= this.#now()) {
            this.forget(tracked.id);
            return;
        }
        // A refresh served by another replica ends the suspension here too.
        if (!tracked.active && record.expiresAt > tracked.suspendedExpiresAt!) this.resume(tracked.id);
        if (!tracked.active) {
            // A parked message keeps this attempt for the resume.
            message.attempts -= 1;
            this.#park(tracked, message);
            return;
        }
        // Its own position once every event before it is settled (SEP-3415: cursor_N rides on event N then), else the watermark.
        const cursor = tracked.pending[0] === message ? message.position : tracked.watermark;
        const body = JSON.stringify({ ...message.occurrence, cursor });
        if (byteLength(body) > MAX_BODY_BYTES) {
            this.#onerror(
                new Error(
                    `webhook subscription ${tracked.id}: abandoned event ${message.occurrence.eventId}, whose body is over ${MAX_BODY_BYTES} bytes`
                )
            );
            this.#settle(tracked, message);
            this.#mark(tracked);
            return;
        }
        const outcome = await this.#post(record.url, record.id, this.#secretsOf(record), message.webhookId, body, tracked.ended.signal);
        if (!this.#isCurrent(tracked)) return;
        const retry = this.#observe(tracked, outcome);
        if (!tracked.active) tracked.suspendedExpiresAt ??= record.expiresAt;
        if (retry) {
            this.#retry(tracked, message);
            return;
        }
        this.#settle(tracked, message);
        const status = 'status' in outcome ? outcome.status : undefined;
        // A 413 loses the event to the subscriber; a 410 is the receiver's own choice.
        if (status === 413) this.#mark(tracked);
        else if (status !== undefined && isSuccess(status)) this.#signalGap(tracked, record);
    }

    // Tells the subscriber, after a delivery it acknowledged or at once from sendGap(), that events were lost before the watermark, whatever refreshes answered; only an acknowledged envelope tells it, of the marks made before that attempt's body was built, and a failed one goes again after the next acknowledged delivery.
    #signalGap(tracked: Tracked, record: WebhookSubscriptionRecord): void {
        if (tracked.told === tracked.marked || tracked.signalling) return;
        // A type without replay has no position to have skipped past (SEP-3415: no gap for `cursor: null`).
        if (tracked.watermark === null) {
            this.#told(tracked, tracked.marked);
            return;
        }
        const fallback = tracked.watermark;
        let covered = tracked.marked;
        const body = (): WebhookControlBody => {
            covered = tracked.marked;
            return { type: 'gap', cursor: this.watermark(record.id) ?? fallback };
        };
        tracked.signalling = true;
        void this.#queueControl(record, 'gap', body, true).then(outcome => {
            if (!this.#isCurrent(tracked)) return;
            tracked.signalling = false;
            if (outcome !== undefined && 'status' in outcome && isSuccess(outcome.status)) this.#told(tracked, covered);
        });
    }

    // Waits out the retry delay out of its slot, then queues the next attempt; after the last it abandons the message.
    #retry(tracked: Tracked, message: Message): void {
        const delay = RETRY_DELAYS_MS[message.attempts - 1];
        if (delay === undefined) {
            this.#abandon(tracked, message, `after ${message.attempts} failed attempts`);
            return;
        }
        this.#release(tracked, message, 'retrying');
        message.retry = unref(setTimeout(() => this.#queue(tracked, message), delay));
    }

    // Holds a message until resume(), out of its slot.
    #park(tracked: Tracked, message: Message): void {
        this.#release(tracked, message, 'parked');
        tracked.parked.push(message);
        this.#cap(tracked);
    }

    // Marks the message acknowledged or abandoned, moves the watermark past the finished messages at the front (and to an advance() made meanwhile once none is left), then frees its slot.
    #settle(tracked: Tracked, message: Message): void {
        let head = tracked.pending[0];
        while (head === message || head?.place === 'done') {
            tracked.pending.shift();
            tracked.watermark = head.position;
            head = tracked.pending[0];
        }
        if (tracked.pending.length === 0 && tracked.advanceTo !== undefined) {
            tracked.watermark = tracked.advanceTo.position;
            tracked.advanceTo = undefined;
        }
        this.#release(tracked, message, 'done');
        if (tracked.pending.length === 0) for (const listener of tracked.drained.splice(0)) listener();
    }

    // Records one outcome in the delivery status and returns whether to retry; 410 and 413 end the message, setting lastError only.
    #observe(tracked: Tracked, outcome: WebhookSendOutcome): boolean {
        const now = this.#now();
        if ('error' in outcome) {
            tracked.lastError = outcome.error;
        } else if (isSuccess(outcome.status)) {
            tracked.lastDeliveryAt = new Date(now).toISOString();
            tracked.lastError = null;
            tracked.failedSince = undefined;
            this.#count(tracked, now, false);
            return false;
        } else {
            tracked.lastError = outcome.status >= 500 ? 'http_5xx' : 'http_4xx';
            if (FINAL_STATUSES.has(outcome.status)) return false;
        }
        tracked.failedSince ??= new Date(now).toISOString();
        this.#count(tracked, now, true);
        return true;
    }

    // Adds one attempt to its minute of the window, which holds the latest minute and the 59 before it, and suspends delivery when the failures in it pass the threshold.
    #count(tracked: Tracked, now: number, failed: boolean): void {
        const minute = Math.floor(now / MINUTE_MS);
        let current = tracked.window.at(-1);
        // A clock that went back counts in the latest minute, so the minutes stay in order.
        if (current === undefined || minute > current.minute) {
            current = { minute, attempts: 0, failures: 0 };
            tracked.window.push(current);
        }
        current.attempts += 1;
        if (failed) current.failures += 1;
        while (tracked.window[0]!.minute <= current.minute - SUSPENSION_WINDOW_MINUTES) tracked.window.shift();
        if (!failed) return;
        let attempts = 0;
        let failures = 0;
        for (const counted of tracked.window) {
            attempts += counted.attempts;
            failures += counted.failures;
        }
        if (attempts >= SUSPENSION_MIN_ATTEMPTS && failures * 100 > SUSPENSION_FAILURE_PERCENT * attempts) tracked.active = false;
    }

    #queueControl(
        record: WebhookSubscriptionRecord,
        type: WebhookControlBody['type'],
        body: () => WebhookControlBody,
        idleOnly: boolean
    ): Promise<WebhookSendOutcome | undefined> {
        return new Promise(resolve => {
            const control: Control = {
                record,
                webhookId: generateWebhookId(type),
                body,
                idleOnly,
                ended: new AbortController(),
                attempts: 0,
                resolve
            };
            this.#controls.add(control);
            this.#sendControl(control);
        });
    }

    // One attempt of a control body, once it may go; it is signed with the record it was queued with, and a body over the limit, or one JSON cannot carry, is not sent.
    #sendControl(control: Control): void {
        const { record } = control;
        const tracked = control.idleOnly ? this.#tracked.get(record.id) : undefined;
        if (tracked !== undefined && tracked.running > 0) {
            tracked.idle.push(() => {
                if (this.#controls.has(control)) this.#sendControl(control);
            });
            return;
        }
        const body = control.body();
        const text = this.#serialised(control, body);
        if (text === undefined) {
            this.#endControl(control);
            return;
        }
        if (byteLength(text) > MAX_BODY_BYTES) {
            this.#onerror(new Error(`webhook subscription ${record.id}: did not send a ${body.type} body over ${MAX_BODY_BYTES} bytes`));
            this.#endControl(control);
            return;
        }
        control.attempts += 1;
        this.#post(record.url, record.id, this.#secretsOf(record), control.webhookId, text, control.ended.signal).then(
            outcome => {
                if (!this.#controls.has(control)) return;
                control.last = outcome;
                if (isRetryable(outcome)) this.#retryControl(control);
                else this.#endControl(control);
            },
            (error: unknown) => {
                if (!this.#controls.has(control)) return;
                this.#onerror(toError(error));
                this.#retryControl(control);
            }
        );
    }

    // The body's JSON, reported once when JSON cannot carry it (a BigInt or a cycle in an error's `data`): a `terminated` body then goes, and goes again, without its `data`, and any other is not sent.
    #serialised(control: Control, body: WebhookControlBody): string | undefined {
        try {
            return JSON.stringify(body);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const id = control.record.id;
            if (body.type !== 'terminated') {
                this.#onerror(
                    new Error(`webhook subscription ${id}: did not send a ${body.type} body that cannot be serialised to JSON: ${reason}`)
                );
                return undefined;
            }
            this.#onerror(
                new Error(
                    `webhook subscription ${id}: sent its terminated body without error data that cannot be serialised to JSON: ${reason}`
                )
            );
            const { code, message } = body.error;
            const stripped: WebhookControlBody = { type: 'terminated', error: { code, message } };
            control.body = () => stripped;
            return JSON.stringify(stripped);
        }
    }

    #retryControl(control: Control): void {
        const delay = RETRY_DELAYS_MS[control.attempts - 1];
        if (delay === undefined) this.#endControl(control);
        else control.retry = unref(setTimeout(() => this.#sendControl(control), delay));
    }

    #stopControl(control: Control): void {
        control.ended.abort();
        this.#endControl(control);
    }

    // Resolves a control body with its last answer and drops it.
    #endControl(control: Control): void {
        this.#controls.delete(control);
        clearTimeout(control.retry);
        control.resolve(control.last);
    }

    // The record's secret, and its previous one during the rotation grace window.
    #secretsOf(record: WebhookSubscriptionRecord): string[] {
        const previous = record.previousSecret;
        return previous !== undefined && this.#now() < previous.expiresAt ? [record.secret, previous.secret] : [record.secret];
    }

    async #post(
        url: string,
        subscriptionId: string,
        secrets: readonly string[],
        webhookId: string,
        body: string,
        signal: AbortSignal
    ): Promise<WebhookSendOutcome> {
        const timestamp = Math.floor(this.#now() / 1000);
        const signature = await signWebhook(
            secrets.map(secret => signingKey(secret)),
            webhookId,
            timestamp,
            body
        );
        const headers = {
            'Content-Type': 'application/json',
            'webhook-id': webhookId,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signature,
            [WEBHOOK_SUBSCRIPTION_ID_HEADER]: subscriptionId
        };
        return this.#sender({ url, headers, body, trusted: this.#trustedOrigins.has(new URL(url).origin), signal });
    }
}
