import type { DeliveryStatus, SubscribeEventsResult } from '@modelcontextprotocol/core/ext/events';
import {
    EVENTS_SUBSCRIBE_METHOD,
    EVENTS_UNSUBSCRIBE_METHOD,
    SubscribeEventsResultSchema,
    UnsubscribeEventsResultSchema
} from '@modelcontextprotocol/core/ext/events';
import type { ProtocolError } from '@modelcontextprotocol/core-internal';
import { canonicalJson, generateWebhookSecret, parseWebhookSecret } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import type { WebhookReceiver, WebhookSink } from './receiver';
import { DriverLoop, jitteredDelay, MAX_TIMER_DELAY_MS, reportGap, retryAfterOf } from './recovery';
import type { EventsConnection, ParamMirror } from './request';
import type { DeliveryQueue, Driver, DriverContext } from './subscription';

// The share of each grant after which the subscription is refreshed.
const REFRESH_AT = 0.75;

export interface WebhookOptions {
    url: string;
    secretProvider?: () => string;
}

// The webhook subscriptions of one extension: identical ones (the same name and canonical arguments, so the same server subscription) share one driver while any of them is open.
export class WebhookSubscriptions {
    readonly #webhook: WebhookOptions;
    readonly #receiver: WebhookReceiver;
    readonly #floorMs: number;
    readonly #open = new Map<string, SharedWebhook>();
    // By key, until it settles: the stop (unsubscribe, then release) of the last one that ended, which the next identical one waits for.
    readonly #stopping = new Map<string, Promise<void>>();

    constructor(webhook: WebhookOptions, receiver: WebhookReceiver, floorMs: number) {
        this.#webhook = webhook;
        this.#receiver = receiver;
        this.#floorMs = floorMs;
    }

    // One subscription's driver: it joins the open server subscription for its name and arguments, or opens one (TypeError for a bad `secretProvider` value).
    driver<T>(context: DriverContext<T>): Driver {
        const key = canonicalJson([context.subscription.name, context.subscription.arguments ?? {}]);
        let shared = this.#open.get(key);
        if (shared === undefined) {
            const after = this.#stopping.get(key) ?? Promise.resolve();
            const opened = new SharedWebhook(context, this.#webhook, this.#receiver, this.#floorMs, after, stopping => {
                // Already taken out by a failure, which leaves nothing to unsubscribe.
                if (this.#open.get(key) !== opened) return;
                this.#open.delete(key);
                if (stopping === undefined) return;
                this.#stopping.set(key, stopping);
                void stopping.then(() => {
                    if (this.#stopping.get(key) === stopping) this.#stopping.delete(key);
                });
            });
            this.#open.set(key, opened);
            shared = opened;
        }
        return shared.join(context);
    }
}

// One server webhook subscription: its driver delivers into the queue of every subscription that joined it.
class SharedWebhook {
    readonly #members = new Set<DriverContext<unknown>>();
    readonly #connection: EventsConnection;
    readonly #driver: WebhookDriver;
    // Settles once the previous identical one has stopped, so the server sees its `events/unsubscribe` before this one's `events/subscribe`.
    readonly #after: Promise<void>;
    // Takes this one out of the open subscriptions, so the next identical subscribe opens a new one (after `stopping`, when given).
    readonly #close: (stopping?: Promise<void>) => void;
    // Where delivery is: the first subscription's cursor until the server reports one.
    #cursor: string | null;
    #deliveryStatus: DeliveryStatus | undefined;
    #started: Promise<void> | undefined;

    constructor(
        first: DriverContext<unknown>,
        webhook: WebhookOptions,
        receiver: WebhookReceiver,
        floorMs: number,
        after: Promise<void>,
        close: (stopping?: Promise<void>) => void
    ) {
        const { connection, subscription } = first;
        const members = this.#members;
        this.#connection = connection;
        this.#after = after;
        this.#close = close;
        this.#cursor = subscription.cursor ?? null;
        const queue: DeliveryQueue<unknown> = {
            push: event => {
                for (const member of members) member.queue.push(event);
            },
            setCursor: cursor => {
                this.#cursor = cursor;
                for (const member of members) member.queue.setCursor(cursor);
            },
            setDeliveryStatus: status => {
                this.#deliveryStatus = status;
                for (const member of members) member.queue.setDeliveryStatus(status);
            },
            fail: error => {
                close();
                for (const member of members) member.queue.fail(error);
            },
            get full() {
                return [...members].some(member => member.queue.full);
            }
        };
        const onGap = (cursor: string | null): void => {
            for (const member of members) reportGap(member.subscription, connection, cursor);
        };
        const context = {
            subscription: { ...subscription, onGap },
            queue,
            connection,
            ...(first.floor !== undefined && { floor: first.floor })
        };
        this.#driver = new WebhookDriver(context, webhook, receiver, floorMs);
    }

    // Delivers to `context` too; the driver returned settles with the shared first exchange, and its stop() ends the server subscription only for the last one.
    join(context: DriverContext<unknown>): Driver {
        const late = this.#members.size > 0;
        const from = this.#cursor;
        this.#members.add(context);
        return {
            start: async () => {
                this.#started ??= this.#after.then(() => this.#driver.start());
                await this.#started;
                if (!late) return;
                // It starts where the shared subscription is; a cursor of its own anywhere else may have skipped events.
                const own = context.subscription.cursor ?? null;
                if (own !== null && own !== from) reportGap(context.subscription, this.#connection, this.#cursor);
                context.queue.setCursor(this.#cursor);
                if (this.#deliveryStatus !== undefined) context.queue.setDeliveryStatus(this.#deliveryStatus);
            },
            stop: async () => {
                if (!this.#members.delete(context) || this.#members.size > 0) return;
                const stopping = this.#driver.stop();
                // Settles however the unsubscribe ends (answered, refused, failed, or the client closed).
                this.#close(stopping.catch(() => {}));
                await stopping;
            }
        };
    }
}

// Webhook delivery (spec §6.3): `events/subscribe` with its own secret, sent again once ¾ of each grant has passed (never sooner than the floor); the receiver routes the server's POSTs here.
class WebhookDriver implements Driver {
    readonly #context: DriverContext<unknown>;
    readonly #loop: DriverLoop<unknown>;
    readonly #receiver: WebhookReceiver;
    readonly #floorMs: number;
    readonly #url: string;
    readonly #secret: string;
    readonly #mirror: ParamMirror;
    readonly #sink: WebhookSink;
    // The id the server derived, from its verification challenge or the subscribe response.
    #id: string | undefined;
    // The server holds the subscription: a subscribe succeeded, and no `terminated` body, terminal failure or close came after it.
    #live = false;
    #withdrawPending: (() => void) | undefined;
    // A `terminated` body routed here since the last subscribe went out.
    #terminated: ProtocolError | undefined;
    // Retry delays taken since the last successful subscribe.
    #attempt = 0;

    // Throws TypeError when `secretProvider` gives something that is not a Standard Webhooks secret.
    constructor(context: DriverContext<unknown>, webhook: WebhookOptions, receiver: WebhookReceiver, floorMs: number) {
        const secret = webhook.secretProvider?.() ?? generateWebhookSecret();
        if (parseWebhookSecret(secret) === undefined) {
            throw new TypeError('webhook.secretProvider must return a Standard Webhooks secret: whsec_ and base64 of 24 to 64 bytes');
        }
        const { name, arguments: args } = context.subscription;
        this.#context = context;
        this.#loop = new DriverLoop(context, 'webhook');
        this.#receiver = receiver;
        this.#floorMs = floorMs;
        this.#url = webhook.url;
        this.#secret = secret;
        this.#mirror = { name, ...(args !== undefined && { arguments: args }) };
        this.#sink = {
            full: () => context.queue.full,
            event: occurrence => {
                if (this.#loop.ended) return;
                context.queue.push(occurrence);
                this.#loop.setCursor(occurrence.cursor ?? null);
            },
            gap: cursor => {
                if (this.#loop.ended) return;
                // A type without replay has no position to have skipped past (SEP: ignore `truncated`).
                if (cursor !== null) reportGap(context.subscription, context.connection, cursor);
                this.#loop.setCursor(cursor);
            },
            terminated: error => {
                if (this.#loop.ended) return;
                this.#terminated = error;
                this.#loop.wake();
            }
        };
    }

    start(): Promise<void> {
        // Checked as the secret is registered: a verification signed with it could bind another subscription's id here.
        if (this.#receiver.holds(this.#secret)) {
            return Promise.reject(new TypeError('webhook.secretProvider must return a secret no other open subscription uses'));
        }
        this.#withdrawPending = this.#receiver.registerPending(this.#secret, id => this.#bind(id));
        return this.#loop.start(() => this.#run(), {
            closed: () => {
                this.#live = false;
                this.#release();
            }
        });
    }

    stop(): Promise<void> {
        return this.#loop.stop(async () => {
            // Eager cleanup (SEP): otherwise the subscription lasts until its grant runs out.
            if (this.#live) await this.#unsubscribe().catch(() => {});
            this.#release();
        });
    }

    // Subscribes until stopped; throws, ending the subscription and releasing the receiver, when a failure calls for it.
    async #run(): Promise<void> {
        const loop = this.#loop;
        try {
            while (!loop.ended) {
                const error = await this.#subscribeAndRefresh();
                if (loop.ended) return;
                await loop.recover(error);
                await loop.sleep(retryAfterOf(error) ?? jitteredDelay(this.#attempt++));
            }
        } catch (error) {
            // Left to lapse: an identical subscribe after this end opens a new driver on the same server subscription.
            this.#live = false;
            this.#release();
            throw error;
        }
    }

    // Subscribes, then refreshes once ¾ of each grant has passed; resolves with the error of a failed subscribe or a `terminated` body.
    async #subscribeAndRefresh(): Promise<unknown> {
        const loop = this.#loop;
        while (!loop.ended) {
            let result: SubscribeEventsResult;
            try {
                result = await this.#subscribe();
            } catch (error) {
                return error;
            }
            if (loop.ended) break;
            const expiresAt = result.refreshBefore === null ? undefined : Date.parse(result.refreshBefore);
            if (Number.isNaN(expiresAt)) return new SdkError(SdkErrorCode.InvalidResult, `Invalid refreshBefore: ${result.refreshBefore}`);
            this.#accept(result);
            if (this.#terminated === undefined) {
                // A `null` grant (no expiry, which this client never asks for) is refreshed after the longest timer.
                await loop.sleep(expiresAt === undefined ? MAX_TIMER_DELAY_MS : this.#refreshDelay(expiresAt - Date.now()));
            }
            if (this.#terminated !== undefined) {
                this.#live = false;
                return this.#terminated;
            }
        }
        return undefined;
    }

    // ¾ of the grant left, never sooner than the floor (so a skewed clock cannot refresh back to back), unless the floor would reach the grant's end.
    #refreshDelay(remainingMs: number): number {
        const delay = Math.max(this.#floorMs, REFRESH_AT * remainingMs);
        return remainingMs > 0 && delay >= remainingMs ? REFRESH_AT * remainingMs : delay;
    }

    // `events/subscribe` with no `ttlMs` suggestion, so the server grants its default.
    #subscribe(): Promise<SubscribeEventsResult> {
        const loop = this.#loop;
        const { maxAgeMs } = loop;
        const params = {
            ...this.#mirror,
            delivery: { mode: 'webhook' as const, url: this.#url, secret: this.#secret },
            cursor: loop.cursor,
            ...(maxAgeMs !== undefined && { maxAgeMs })
        };
        this.#terminated = undefined;
        return this.#context.connection.request(EVENTS_SUBSCRIBE_METHOD, params, SubscribeEventsResultSchema, this.#mirror, {
            signal: loop.signal
        });
    }

    #unsubscribe(): Promise<unknown> {
        const params = { ...this.#mirror, delivery: { url: this.#url } };
        return this.#context.connection.request(EVENTS_UNSUBSCRIBE_METHOD, params, UnsubscribeEventsResultSchema, this.#mirror);
    }

    // A subscribe succeeded: the receiver routes its id here, and the watermark, the delivery status and a gap are taken from it.
    #accept(result: SubscribeEventsResult): void {
        const loop = this.#loop;
        const cursor = result.cursor ?? null;
        this.#attempt = 0;
        this.#live = true;
        this.#bind(result.id);
        this.#withdrawPending?.();
        if (result.deliveryStatus !== undefined) this.#context.queue.setDeliveryStatus(result.deliveryStatus);
        loop.succeeded(cursor, result.truncated === true);
        loop.setCursor(cursor);
        loop.subscribed();
    }

    #bind(id: string): void {
        this.#id = id;
        this.#receiver.bind(id, this.#secret, this.#sink);
    }

    // The receiver stops routing deliveries here and forgets the secret.
    #release(): void {
        this.#withdrawPending?.();
        if (this.#id !== undefined) this.#receiver.forget(this.#id, this.#sink);
        this.#id = undefined;
    }
}
