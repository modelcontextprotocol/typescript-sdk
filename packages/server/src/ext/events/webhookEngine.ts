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
// The most messages a suspended subscription holds: as many as the emit buffer holds by default.
const MAX_PARKED_MESSAGES = 10_000;
// Delivery is suspended once more than 95 % of at least 100 attempts in the last 60 minutes failed.
const SUSPENSION_WINDOW_MS = 3_600_000;
const SUSPENSION_MIN_ATTEMPTS = 100;
const SUSPENSION_FAILURE_PERCENT = 95;
// A failed verification of a (principal, url) is answered again for this long without a POST.
const FAILED_VERIFICATION_MS = 60_000;
// Verification POSTs to one destination host: one at a time, and at most 10 in any 60 s; at most 10 more wait their turn.
const VERIFICATIONS_PER_WINDOW = 10;
const VERIFICATION_WINDOW_MS = 60_000;
// The retry hint when the host's wait is full: nodeWebhookSender's 5 s timeout, by when the verification in flight has ended.
const QUEUE_FULL_RETRY_MS = 5000;
// The most failed pairs and destination hosts the verification limits remember.
const MAX_REMEMBERED = 10_000;

const encoder = new TextEncoder();

export interface WebhookEngineOptions {
    readonly sender: WebhookSender;
    readonly store: WebhookSubscriptionStore;
    // Read at every send, so origins added later count.
    readonly trustedOrigins: ReadonlySet<string>;
    onerror(error: Error): void;
    readonly now?: () => number;
}

// One event POST to one subscription, under one webhook-id until it is acknowledged or abandoned.
interface Message {
    readonly webhookId: string;
    readonly occurrence: EventOccurrence;
    // The subscription's position after this event.
    readonly position: string | null;
    attempts: number;
    done: boolean;
    retry?: ReturnType<typeof setTimeout>;
}

// One control body to one subscription, under one webhook-id until it is answered or abandoned; it never touches the watermark.
interface Control {
    readonly record: WebhookSubscriptionRecord;
    readonly webhookId: string;
    readonly body: string;
    // Aborts its send in flight once it is stopped.
    readonly ended: AbortController;
    attempts: number;
    last?: WebhookSendOutcome;
    retry?: ReturnType<typeof setTimeout>;
    readonly resolve: (outcome: WebhookSendOutcome | undefined) => void;
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
    // Messages that came due while delivery was suspended, oldest first.
    parked: Message[];
    active: boolean;
    lastDeliveryAt: string | null;
    lastError: DeliveryErrorCategory | null;
    // The first failure since the last acknowledgement.
    failedSince?: string;
    // The attempts of the last SUSPENSION_WINDOW_MS, oldest first, and how many of them failed.
    recent: Array<{ readonly at: number; readonly failed: boolean }>;
    recentFailures: number;
}

// One `principal\0url` handshake in flight: the subscribes waiting for it, and the abort that pulls it from the host's queue once all of them were cancelled.
interface Handshake {
    readonly done: Promise<void>;
    readonly abandoned: AbortController;
    callers: number;
}

// One destination host's verification POSTs: whether one holds the slot, the verifications waiting for it (oldest first), and the send times of the last window, oldest first.
interface HostVerifications {
    inFlight: boolean;
    readonly waiting: Array<{ resolve(): void; reject(error: unknown): void }>;
    readonly sent: number[];
}

// Adds `key` to `map`; at MAX_REMEMBERED it first drops the entries `stale` says are done, then the oldest.
function remember<V>(map: Map<string, V>, key: string, value: V, stale: (held: V) => boolean): void {
    map.delete(key);
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
    // Aborts verification sends in flight on clear(); made at first use, as Cloudflare Workers refuse it at module scope.
    #lifetime: AbortController | undefined;

    constructor(options: WebhookEngineOptions) {
        this.#sender = options.sender;
        this.#store = options.store;
        this.#trustedOrigins = options.trustedOrigins;
        this.#onerror = options.onerror;
        this.#now = options.now ?? (() => Date.now());
    }

    // Subscriptions this process holds delivery state for.
    get size(): number {
        return this.#tracked.size;
    }

    // One attempt, which the subscribe call waits for, after the host's verification in flight; throws `callbackEndpointError` with the failure category as `data.reason`, or `resourceExhausted` at the host's limit.
    async verify(principal: string, url: string, secret: string, subscriptionId: string, signal?: AbortSignal): Promise<void> {
        const key = `${principal}\u0000${url}`;
        if (!this.#verified.has(key)) await this.#verifyPair(key, url, secret, subscriptionId, signal);
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
        this.#drop(id);
        this.#start(id, startCursor);
    }

    // Queues one event POST and returns; calls for one subscription come in position order, and `seed` starts the watermark of an untracked id.
    deliver(record: WebhookSubscriptionRecord, occurrence: EventOccurrence, position: string | null, seed: string | null): void {
        const tracked = this.#tracked.get(record.id) ?? this.#start(record.id, seed);
        const message: Message = { webhookId: generateWebhookId(), occurrence, position, attempts: 0, done: false };
        tracked.pending.push(message);
        this.#attempt(tracked, message, record);
    }

    // Queues a control body, retried like an event, and resolves with its last answer (`undefined` without one); request paths must not await it.
    sendControl(record: WebhookSubscriptionRecord, body: WebhookControlBody): Promise<WebhookSendOutcome | undefined> {
        const text = JSON.stringify(body);
        if (byteLength(text) > MAX_BODY_BYTES) {
            this.#onerror(new Error(`webhook subscription ${record.id}: did not send a ${body.type} body over ${MAX_BODY_BYTES} bytes`));
            return Promise.resolve(undefined);
        }
        return new Promise(resolve => {
            const control: Control = {
                record,
                webhookId: generateWebhookId(body.type),
                body: text,
                ended: new AbortController(),
                attempts: 0,
                resolve
            };
            this.#controls.add(control);
            this.#sendControl(control);
        });
    }

    watermark(id: string): string | null | undefined {
        return this.#tracked.get(id)?.watermark;
    }

    // Moves the watermark to `position` when no message is pending, so a quiet upstream still advances it; it never passes an unsettled message.
    advance(id: string, position: string | null): void {
        const tracked = this.#tracked.get(id);
        if (tracked !== undefined && tracked.pending.length === 0) tracked.watermark = position;
    }

    status(id: string): DeliveryStatus | undefined {
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) return undefined;
        const { active, lastDeliveryAt, lastError, failedSince } = tracked;
        return failedSince === undefined ? { active, lastDeliveryAt, lastError } : { active, lastDeliveryAt, lastError, failedSince };
    }

    // Reactivates a suspended subscription and retries the messages that waited.
    resume(id: string): void {
        const tracked = this.#tracked.get(id);
        if (tracked === undefined || tracked.active) return;
        tracked.active = true;
        tracked.recent = [];
        tracked.recentFailures = 0;
        const parked = tracked.parked;
        tracked.parked = [];
        for (const message of parked) this.#attempt(tracked, message);
    }

    // Drops the subscription's delivery state and stops its control bodies; its last subscription also drops a (principal, url) verification.
    forget(id: string): void {
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
        this.#lifetime?.abort();
        this.#lifetime = undefined;
    }

    // The pair's handshake in flight, or a new one; `signal` (the subscribe request's) stops this caller waiting for it.
    async #verifyPair(key: string, url: string, secret: string, subscriptionId: string, signal: AbortSignal | undefined): Promise<void> {
        let handshake = this.#handshakes.get(key);
        if (handshake === undefined) {
            const abandoned = new AbortController();
            const done = this.#handshake(key, url, secret, subscriptionId, abandoned.signal).finally(() => {
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

    // One verification POST, unless a failure of the pair is still remembered, the host is at its limit, or every subscribe waiting for it was cancelled while it queued.
    async #handshake(key: string, url: string, secret: string, subscriptionId: string, abandoned: AbortSignal): Promise<void> {
        const failed = this.#failed.get(key);
        if (failed !== undefined && this.#now() < failed.until) throw verificationError(failed.reason);
        this.#failed.delete(key);
        const host = await this.#claimHost(url, abandoned);
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
                const until = this.#now() + FAILED_VERIFICATION_MS;
                remember(this.#failed, key, { reason, until }, held => held.until <= this.#now());
            }
            throw verificationError(reason);
        } finally {
            this.#releaseHost(host);
        }
    }

    // Waits for the host's one verification slot, leaving the queue when `abandoned` aborts, then counts the POST; throws `resourceExhausted` with a retry hint when the wait or the window is full.
    async #claimHost(url: string, abandoned: AbortSignal): Promise<HostVerifications> {
        const name = new URL(url).hostname.toLowerCase();
        let host = this.#hosts.get(name);
        if (host === undefined) {
            host = { inFlight: false, waiting: [], sent: [] };
            const start = this.#now() - VERIFICATION_WINDOW_MS;
            remember(this.#hosts, name, host, held => !held.inFlight && (held.sent.at(-1) ?? start) <= start);
        }
        if (host.inFlight) {
            if (host.waiting.length >= VERIFICATIONS_PER_WINDOW) throw verificationLimit(QUEUE_FULL_RETRY_MS);
            await this.#waitTurn(host, abandoned);
            // Handed the slot just as it was abandoned: pass it on without a POST.
            if (abandoned.aborted) {
                this.#releaseHost(host);
                throw abandoned.reason;
            }
        } else {
            host.inFlight = true;
        }
        const now = this.#now();
        const start = now - VERIFICATION_WINDOW_MS;
        const { sent } = host;
        while (sent[0] !== undefined && sent[0] <= start) sent.shift();
        if (sent.length >= VERIFICATIONS_PER_WINDOW) {
            this.#releaseHost(host);
            throw verificationLimit(sent[0]! - start);
        }
        sent.push(now);
        return host;
    }

    // Resolves holding the slot, which #releaseHost hands over; rejects at once, out of the queue, when `abandoned` aborts.
    #waitTurn(host: HostVerifications, abandoned: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const leave = (): void => {
                const index = host.waiting.indexOf(waiter);
                if (index !== -1) host.waiting.splice(index, 1);
                reject(abandoned.reason);
            };
            const waiter = {
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
        if (next === undefined) host.inFlight = false;
        else next.resolve();
    }

    #start(id: string, watermark: string | null): Tracked {
        const tracked: Tracked = {
            id,
            ended: new AbortController(),
            watermark,
            pending: [],
            parked: [],
            active: true,
            lastDeliveryAt: null,
            lastError: null,
            recent: [],
            recentFailures: 0
        };
        this.#tracked.set(id, tracked);
        return tracked;
    }

    #drop(id: string): void {
        const tracked = this.#tracked.get(id);
        if (tracked === undefined) return;
        this.#tracked.delete(id);
        tracked.ended.abort();
        for (const message of tracked.pending) clearTimeout(message.retry);
    }

    #isCurrent(tracked: Tracked): boolean {
        return this.#tracked.get(tracked.id) === tracked;
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
        const record = supplied ?? (await this.#store.get(tracked.id));
        if (!this.#isCurrent(tracked)) return;
        // A record gone from the store, or expired, ends what this process holds for the subscription.
        if (record === undefined || record.expiresAt <= this.#now()) {
            this.forget(tracked.id);
            return;
        }
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
            return;
        }
        const outcome = await this.#post(record.url, record.id, this.#secretsOf(record), message.webhookId, body, tracked.ended.signal);
        if (!this.#isCurrent(tracked)) return;
        if (this.#observe(tracked, outcome)) this.#retry(tracked, message);
        else this.#settle(tracked, message);
    }

    #retry(tracked: Tracked, message: Message): void {
        const delay = RETRY_DELAYS_MS[message.attempts - 1];
        if (delay === undefined) {
            this.#settle(tracked, message);
            return;
        }
        message.retry = unref(setTimeout(() => this.#attempt(tracked, message), delay));
    }

    // Holds a message until resume(); past the cap the oldest one held is abandoned.
    #park(tracked: Tracked, message: Message): void {
        tracked.parked.push(message);
        const oldest = tracked.parked.length > MAX_PARKED_MESSAGES ? tracked.parked.shift() : undefined;
        if (oldest !== undefined) this.#settle(tracked, oldest);
    }

    // Marks the message acknowledged or abandoned, and moves the watermark past the finished messages at the front.
    #settle(tracked: Tracked, message: Message): void {
        message.done = true;
        let head = tracked.pending[0];
        while (head?.done === true) {
            tracked.pending.shift();
            tracked.watermark = head.position;
            head = tracked.pending[0];
        }
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

    // Adds one attempt to the window and suspends delivery when the failures in it pass the threshold.
    #count(tracked: Tracked, now: number, failed: boolean): void {
        tracked.recent.push({ at: now, failed });
        if (failed) tracked.recentFailures += 1;
        let oldest = tracked.recent[0];
        while (oldest !== undefined && oldest.at <= now - SUSPENSION_WINDOW_MS) {
            tracked.recent.shift();
            if (oldest.failed) tracked.recentFailures -= 1;
            oldest = tracked.recent[0];
        }
        const total = tracked.recent.length;
        if (failed && total >= SUSPENSION_MIN_ATTEMPTS && tracked.recentFailures * 100 > SUSPENSION_FAILURE_PERCENT * total) {
            tracked.active = false;
        }
    }

    // One attempt of a control body; it is signed with the record it was queued with.
    #sendControl(control: Control): void {
        control.attempts += 1;
        const { record } = control;
        this.#post(record.url, record.id, this.#secretsOf(record), control.webhookId, control.body, control.ended.signal).then(
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
