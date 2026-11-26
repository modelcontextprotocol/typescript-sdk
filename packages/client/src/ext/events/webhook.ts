import type { DeliveryStatus, EventOccurrence, SubscribeEventsResult } from '@modelcontextprotocol/core/ext/events';
import {
    EVENTS_SUBSCRIBE_METHOD,
    EVENTS_UNSUBSCRIBE_METHOD,
    SubscribeEventsResultSchema,
    UnsubscribeEventsResultSchema
} from '@modelcontextprotocol/core/ext/events';
import { ProtocolError } from '@modelcontextprotocol/core-internal';
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

// Whether a `terminated` body reports the end `error` was: the same JSON-RPC code, message and data.
function sameEnd(body: ProtocolError, error: unknown): boolean {
    return (
        error instanceof ProtocolError &&
        body.code === error.code &&
        body.message === error.message &&
        canonicalJson(body.data ?? null) === canonicalJson(error.data ?? null)
    );
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
    // Members that have dropped events since their loop last took their queue down to half the limit.
    readonly #dropping = new Set<DriverContext<unknown>>();

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
            // Taken when one member's queue took it.
            push: event => {
                let taken = false;
                for (const member of members) taken = this.#deliver(member, event) || taken;
                return taken;
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
            // An event is refused only while every member's loop has fallen behind; while one has room, a full one drops for it.
            get full() {
                return members.size > 0 && [...members].every(member => member.queue.full);
            },
            // Once one member's loop has taken half of its queue, or its subscription ended.
            room: () => Promise.race([...members].map(member => member.queue.room?.() ?? Promise.resolve()))
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

    // A member whose loop has fallen behind drops its oldest queued event to take `event`, as push does for a type without replay: one gap per episode (at the cursor delivery continues from), which ends once it has taken half its queue. Answers whether its queue took `event`.
    #deliver(member: DriverContext<unknown>, event: EventOccurrence): boolean {
        const taken = member.queue.push(event);
        if (member.queue.trim?.() !== true || this.#dropping.has(member)) return taken;
        this.#dropping.add(member);
        reportGap(member.subscription, this.#connection, event.cursor ?? null);
        void member.queue.room?.().then(() => this.#dropping.delete(member));
        return taken;
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

// Webhook delivery (SEP-3415 #webhook-based-delivery): `events/subscribe` with its own secret, sent again once ¾ of each grant has passed (never sooner than the floor); the receiver routes the server's POSTs here.
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
    // A `terminated` body routed here and not yet acted on.
    #terminated: ProtocolError | undefined;
    // The failure the loop last recovered from, until a subscribe succeeds: a `terminated` body that matches it is that end, which the server answered a refresh with and also POSTed.
    #recovered: unknown;
    // Retry delays taken since the last successful subscribe.
    #attempt = 0;
    // When the last grant ends (`undefined` for none, or a `null` one), and whether a `terminated` body ended the subscription since it was given.
    #grantEnds: number | undefined;
    #serverEnded = false;
    // Refused events of a type without replay have been reported as a gap since a loop last took half its queue.
    #refusing = false;

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
            refuses: () => {
                if (!context.queue.full) return false;
                // A type without replay cannot get back what the server gives up on meanwhile: one gap per episode, which ends once a loop has taken half its queue.
                if (this.#loop.cursor === null && !this.#refusing) {
                    this.#refusing = true;
                    reportGap(context.subscription, context.connection, null);
                    void context.queue.room?.().then(() => (this.#refusing = false));
                }
                return true;
            },
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
                // The copy of the end being recovered from is taken at once, which drops it and leaves the retry wait as it is.
                if (sameEnd(error, this.#recovered)) this.#takeTerminated();
                else this.#loop.wake();
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
                let error = await this.#subscribeAndRefresh();
                while (!loop.ended) {
                    this.#recovered = error;
                    await loop.recover(error);
                    let terminated = this.#takeTerminated();
                    if (terminated === undefined) {
                        await loop.sleep(retryAfterOf(error) ?? jitteredDelay(this.#attempt++));
                        terminated = this.#takeTerminated();
                    }
                    if (terminated === undefined) break;
                    // A `terminated` body that came while a failure was recovered or waited for its retry is recovered from as one at any other time is, unless it is that failure's copy.
                    error = terminated;
                }
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
            const sentAt = Date.now();
            let result: SubscribeEventsResult;
            try {
                result = await this.#subscribe();
            } catch (error) {
                return error;
            }
            if (loop.ended) break;
            const expiresAt = result.refreshBefore === null ? undefined : Date.parse(result.refreshBefore);
            if (Number.isNaN(expiresAt)) return new SdkError(SdkErrorCode.InvalidResult, `Invalid refreshBefore: ${result.refreshBefore}`);
            // The server stopped holding the subscription before this subscribe (a `terminated` body, or a grant that ended before it went out): a type without replay starts again from now, unless a refused-event episode already reported that.
            const lapsed = this.#serverEnded || (this.#grantEnds !== undefined && sentAt >= this.#grantEnds);
            if (lapsed && !this.#refusing) loop.lapsed();
            this.#serverEnded = false;
            // A grant already over by this clock when it arrived says nothing about a lapse (a clock ahead of the server's).
            this.#grantEnds = expiresAt !== undefined && expiresAt > Date.now() ? expiresAt : undefined;
            this.#accept(result);
            if (this.#terminated === undefined) {
                // A `null` grant (no expiry, which this client never asks for) is refreshed after the longest timer.
                await loop.sleep(expiresAt === undefined ? MAX_TIMER_DELAY_MS : this.#refreshDelay(expiresAt - Date.now()));
            }
            const terminated = this.#takeTerminated();
            if (terminated !== undefined) return terminated;
        }
        return undefined;
    }

    // The `terminated` body routed here, taken once: the server no longer holds the subscription. `undefined` for the copy of the end being recovered from.
    #takeTerminated(): ProtocolError | undefined {
        const terminated = this.#terminated;
        if (terminated === undefined) return undefined;
        this.#terminated = undefined;
        this.#live = false;
        this.#serverEnded = true;
        return sameEnd(terminated, this.#recovered) ? undefined : terminated;
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
        this.#recovered = undefined;
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
