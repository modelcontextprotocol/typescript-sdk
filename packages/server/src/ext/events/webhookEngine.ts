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
const MAX_BODY_BYTES = 262_144;
// Delivery is suspended once more than 95 % of at least 100 attempts in the last 60 minutes failed.
const SUSPENSION_WINDOW_MS = 3_600_000;
const SUSPENSION_MIN_ATTEMPTS = 100;
const SUSPENSION_FAILURE_PERCENT = 95;

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

// What this process holds for one subscription it delivers to.
interface Tracked {
    readonly id: string;
    // Aborts the subscription's sends in flight once it is forgotten.
    readonly ended: AbortController;
    // Every event at or before this position is acknowledged or abandoned.
    watermark: string | null;
    // Messages not yet acknowledged or abandoned, in position order.
    readonly pending: Message[];
    // Messages that came due while delivery was suspended.
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

// Sends webhook POSTs: endpoint verification, signed event deliveries with per-message retries and the watermark cursor, and control bodies.
export class WebhookEngine {
    readonly #sender: WebhookSender;
    readonly #store: WebhookSubscriptionStore;
    readonly #trustedOrigins: ReadonlySet<string>;
    readonly #onerror: (error: Error) => void;
    readonly #now: () => number;
    readonly #tracked = new Map<string, Tracked>();
    // Each verified `principal\0url` with the subscription ids it covers; it lasts while one of them does.
    readonly #verified = new Map<string, Set<string>>();
    readonly #verifiedKeyOf = new Map<string, string>();
    // Aborts verification and control sends in flight on clear().
    #lifetime = new AbortController();

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

    // Throws `callbackEndpointError` with the failure category as `data.reason`.
    async verify(principal: string, url: string, secret: string, subscriptionId: string): Promise<void> {
        const key = `${principal}\u0000${url}`;
        let covered = this.#verified.get(key);
        if (covered === undefined) {
            const challenge = challengeNonce();
            const body = JSON.stringify({ type: 'verification', challenge });
            const webhookId = generateWebhookId('verification');
            const outcome = await this.#post(url, subscriptionId, [signingKey(secret)], webhookId, body, this.#lifetime.signal);
            if ('error' in outcome) throw verificationError(outcome.error);
            if (!echoes(outcome, challenge)) throw verificationError('challenge_failed');
            covered = this.#verified.get(key) ?? new Set();
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

    // Queues one event POST and returns; `seed` is the watermark to start from when this process does not track `record.id`.
    deliver(record: WebhookSubscriptionRecord, occurrence: EventOccurrence, position: string | null, seed: string | null): void {
        const tracked = this.#tracked.get(record.id) ?? this.#start(record.id, seed);
        const message: Message = { webhookId: generateWebhookId(), occurrence, position, attempts: 0, done: false };
        tracked.pending.push(message);
        this.#attempt(tracked, message, record);
    }

    // One signed POST of a control body, not retried; rejects for a body over the cap.
    async sendControl(record: WebhookSubscriptionRecord, body: WebhookControlBody): Promise<WebhookSendOutcome> {
        const text = JSON.stringify(body);
        if (byteLength(text) > MAX_BODY_BYTES) {
            throw new Error(`webhook subscription ${record.id}: the ${body.type} body is over ${MAX_BODY_BYTES} bytes`);
        }
        return this.#post(record.url, record.id, this.#signingKeys(record), generateWebhookId(body.type), text, this.#lifetime.signal);
    }

    watermark(id: string): string | null | undefined {
        return this.#tracked.get(id)?.watermark;
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

    // Drops the subscription's delivery state; the last subscription of a (principal, url) also drops its verification.
    forget(id: string): void {
        this.#drop(id);
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
        this.#verified.clear();
        this.#verifiedKeyOf.clear();
        this.#lifetime.abort();
        this.#lifetime = new AbortController();
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
            this.#onerror(error instanceof Error ? error : new Error(String(error)));
            this.#retry(tracked, message);
        });
    }

    async #try(tracked: Tracked, message: Message, supplied: WebhookSubscriptionRecord | undefined): Promise<void> {
        if (!tracked.active) {
            tracked.parked.push(message);
            return;
        }
        message.attempts += 1;
        const record = supplied ?? (await this.#store.get(tracked.id));
        if (!this.#isCurrent(tracked)) return;
        // A record gone from the store, or expired, ends what this process holds for the subscription.
        if (record === undefined || record.expiresAt <= this.#now()) {
            this.forget(tracked.id);
            return;
        }
        const body = JSON.stringify({ ...message.occurrence, cursor: tracked.watermark });
        if (byteLength(body) > MAX_BODY_BYTES) {
            this.#onerror(
                new Error(
                    `webhook subscription ${tracked.id}: abandoned event ${message.occurrence.eventId}, whose body is over ${MAX_BODY_BYTES} bytes`
                )
            );
            this.#settle(tracked, message);
            return;
        }
        const outcome = await this.#post(record.url, record.id, this.#signingKeys(record), message.webhookId, body, tracked.ended.signal);
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
            if (outcome.status === 410 || outcome.status === 413) return false;
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

    // The record's secret, and its previous one during the rotation grace window.
    #signingKeys(record: WebhookSubscriptionRecord): Uint8Array[] {
        const keys = [signingKey(record.secret)];
        const previous = record.previousSecret;
        if (previous !== undefined && this.#now() < previous.expiresAt) keys.push(signingKey(previous.secret));
        return keys;
    }

    async #post(
        url: string,
        subscriptionId: string,
        keys: readonly Uint8Array[],
        webhookId: string,
        body: string,
        signal: AbortSignal
    ): Promise<WebhookSendOutcome> {
        const timestamp = Math.floor(this.#now() / 1000);
        const headers = {
            'Content-Type': 'application/json',
            'webhook-id': webhookId,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': await signWebhook(keys, webhookId, timestamp, body),
            [WEBHOOK_SUBSCRIPTION_ID_HEADER]: subscriptionId
        };
        return this.#sender({ url, headers, body, trusted: this.#trustedOrigins.has(new URL(url).origin), signal });
    }
}
