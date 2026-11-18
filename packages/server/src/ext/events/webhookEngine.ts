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
    // Aborts verification sends in flight on clear().
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

    // One attempt, which the subscribe call waits for; throws `callbackEndpointError` with the failure category as `data.reason`.
    async verify(principal: string, url: string, secret: string, subscriptionId: string): Promise<void> {
        const key = `${principal}\u0000${url}`;
        let covered = this.#verified.get(key);
        if (covered === undefined) {
            const challenge = challengeNonce();
            const body = JSON.stringify({ type: 'verification', challenge });
            const webhookId = generateWebhookId('verification');
            const outcome = await this.#post(url, subscriptionId, [secret], webhookId, body, this.#lifetime.signal);
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
