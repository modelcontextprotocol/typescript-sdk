import type { DeliveryMode, ListEventsResult } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_EXTENSION_ID, EVENTS_LIST_METHOD, eventsCapabilityOf } from '@modelcontextprotocol/core/ext/events';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import type { Client } from '../../client/client';
import { NoCompatibleDeliveryModeError } from './errors';
import { PollDriver } from './poll';
import { PushDriver } from './push';
import { WebhookReceiver } from './receiver';
import { EventsConnection } from './request';
import type { Driver, DriverContext, EventSubscription, SubscribeOptions } from './subscription';
import { SubscriptionQueue } from './subscription';
import { WebhookSubscriptions } from './webhook';

const DEFAULT_POLL_INTERVAL_FLOOR_MS = 1000;

// Most preferred first (SEP-3415 Appendix A).
const PREFERENCE: readonly DeliveryMode[] = ['webhook', 'push', 'poll'];

/**
 * Options for {@linkcode EventsClientExtension}.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export interface EventsClientOptions {
    /**
     * Webhook delivery: the callback URL the server POSTs events to, where
     * {@linkcode EventsClientExtension.createWebhookHandler} is mounted. Each
     * server subscription signs with its own `whsec_` secret, random unless
     * `secretProvider` supplies it; a value that is not a Standard Webhooks
     * secret (`whsec_` and base64 of 24 to 64 bytes) makes `subscribe()`
     * throw `TypeError`. With it set, a subscription prefers webhook where the
     * event type offers it.
     */
    webhook?: { url: string; secretProvider?: () => string };
    /**
     * The shortest wait between two polls, whatever `nextPollMs` the server
     * recommends, and between two webhook refreshes, whatever the grant
     * (a skewed clock cannot make them back to back). Default 1000.
     */
    pollIntervalFloorMs?: number;
}

// The delivery mode for a subscription; throws NoCompatibleDeliveryModeError when none fits.
export function selectDeliveryMode(
    eventName: string,
    offered: readonly DeliveryMode[],
    forced: DeliveryMode | undefined,
    webhookConfigured: boolean
): DeliveryMode {
    const usable = PREFERENCE.filter(mode => (mode !== 'webhook' || webhookConfigured) && (forced === undefined || mode === forced));
    const mode = usable.find(candidate => offered.includes(candidate));
    if (mode === undefined) throw new NoCompatibleDeliveryModeError(eventName, offered, usable);
    return mode;
}

/**
 * Client side of the MCP Events extension (SEP-3415): lists a server's event
 * types and subscribes to them. Each subscription picks a delivery mode,
 * preferring webhook (when configured), then push, then poll, and runs it,
 * deduplicating by `eventId` and tracking the cursor. Events is used only on
 * protocol revision `2026-07-28` and later.
 *
 * @example
 * ```ts
 * const events = new EventsClientExtension();
 * events.attach(client);
 * await client.connect(transport);
 * const subscription = await events.subscribe({ name: 'incident.created', arguments: { severity: 'P1' } });
 * for await (const event of subscription) {
 *     console.log(event.data);
 * }
 * ```
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class EventsClientExtension {
    /** The extension identifier the client declares. */
    readonly id = EVENTS_EXTENSION_ID;
    readonly #options: EventsClientOptions;
    readonly #floorMs: number;
    readonly #receiver = new WebhookReceiver();
    readonly #webhooks: WebhookSubscriptions | undefined;
    #connection: EventsConnection | undefined;

    /** @throws {TypeError} when `pollIntervalFloorMs` is not a positive finite number. */
    constructor(options: EventsClientOptions = {}) {
        const floorMs = options.pollIntervalFloorMs ?? DEFAULT_POLL_INTERVAL_FLOOR_MS;
        if (!(Number.isFinite(floorMs) && floorMs > 0)) {
            throw new TypeError(`pollIntervalFloorMs must be a positive finite number (got ${String(floorMs)})`);
        }
        this.#options = options;
        this.#floorMs = floorMs;
        this.#webhooks = options.webhook === undefined ? undefined : new WebhookSubscriptions(options.webhook, this.#receiver, floorMs);
    }

    /**
     * Declares the extension in `client`'s capabilities. Call it before
     * `client.connect()`; one client per instance, and attaching to the same
     * client again does nothing.
     *
     * @throws {Error} after `client` connected, or when already attached to another client.
     */
    attach(client: Client): void {
        if (this.#connection?.client === client) return;
        if (this.#connection !== undefined) throw new Error('This EventsClientExtension is already attached to another client');
        client.registerCapabilities({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
        this.#connection = new EventsConnection(client);
    }

    /** The server advertised the extension and the connection is on protocol `2026-07-28` or later. `false` before connect. */
    get supported(): boolean {
        const client = this.#connection?.client;
        return (
            client !== undefined && client.getProtocolEra() === 'modern' && eventsCapabilityOf(client.getServerCapabilities()) !== undefined
        );
    }

    /**
     * Lists the server's event types, walking every page unless given a
     * cursor. Event types whose `x-mcp-header` annotations are invalid are
     * left out, with a warning.
     *
     * @throws {EventsError} when the server refuses the request.
     * @throws {SdkError} `CapabilityNotSupported` when {@linkcode EventsClientExtension.supported} is `false`.
     */
    async list(params: { cursor?: string } = {}): Promise<ListEventsResult> {
        return this.#require(EVENTS_LIST_METHOD).list(params.cursor);
    }

    /**
     * Subscribes to an event type, looking its descriptor up in the last
     * `events/list` (fetched again when it is not there), and resolves once
     * the first exchange with the server succeeds (for poll, the first
     * `events/poll` response; for push, the first
     * `notifications/events/active`; for webhook, the `events/subscribe`
     * response). A transient failure of that exchange (a
     * transport error, or a JSON-RPC error that is not an Events kind) does
     * not reject: delivery is retried in the background. A `cursor` the
     * server refuses because the event type's schema changed is dropped: the
     * event types are listed again, the subscription starts from now, and
     * `onGap` reports the fresh cursor. A `-32020` lists the event types again
     * and retries once. Once subscribed, every mode recovers from errors as
     * {@linkcode EventSubscription} describes.
     *
     * Webhook subscriptions with the same name and arguments are one server
     * subscription. A later one joins the open one rather than sending
     * `events/subscribe` (its `cursor` and `maxAgeMs` are not sent; `onGap`
     * reports a `cursor` of its own that is not where the shared one is) and
     * settles as that one's first exchange does. Each gets every event in its
     * own loop, an end of the shared one ends them all, and
     * `events/unsubscribe` goes out when the last of them is cancelled.
     *
     * @throws {EventsError} when the server refuses the subscription: `notFound` for an event type it does not list or
     *   no longer serves, `invalidParams` for arguments its `inputSchema` rejects, `forbidden`, or another kind.
     * @throws {NoCompatibleDeliveryModeError} when no delivery mode the event type offers is usable here, also when
     *   the schema change that refused `cursor` left the event type without the selected mode.
     * @throws {SdkError} `CapabilityNotSupported` when {@linkcode EventsClientExtension.supported} is `false`,
     *   `ConnectionClosed` when the client closes before the first exchange answers, or another code when that
     *   exchange fails in the SDK (for example a request timeout).
     * @throws {ProtocolError} `-32020` when the server rejects the `Mcp-Param` headers again after a re-list.
     * @throws {TypeError} when `webhook.secretProvider` returns something that is not a Standard Webhooks secret.
     */
    async subscribe<T = Record<string, unknown>>(options: SubscribeOptions): Promise<EventSubscription<T>> {
        const connection = this.#require('subscribe');
        let descriptor = connection.descriptor(options.name);
        if (descriptor === undefined) {
            await connection.list();
            descriptor = connection.descriptor(options.name);
        }
        if (descriptor === undefined) throw new EventsError('notFound', 'Event type not found', { kind: 'event' });
        const mode = selectDeliveryMode(options.name, descriptor.delivery, options.delivery, this.#options.webhook !== undefined);
        const queue = new SubscriptionQueue<T>(mode, options.cursor ?? null);
        try {
            await queue.run(this.#driver(mode, { subscription: { ...options }, queue, connection }));
        } catch (error) {
            await queue.cancel();
            throw error;
        }
        return queue;
    }

    /**
     * The receiver for webhook delivery, a `(request: Request) => Promise<Response>`
     * to mount at `webhook.url` in any fetch-style server; every handler it
     * returns serves this instance's subscriptions. It verifies each POST's
     * Standard Webhooks signature over the raw body, answers the server's
     * verification challenge, delivers each `webhook-id` once, and routes
     * events and `gap` and `terminated` bodies into their subscription.
     * Answers: `405` to anything but POST, `413` to a body over 256 KiB,
     * `400` to a missing header, a timestamp more than 5 minutes off or a
     * malformed body, `401` to a bad signature, and `503` to a subscription
     * id it does not route (yet), which the server retries.
     */
    createWebhookHandler(): (request: Request) => Promise<Response> {
        const receiver = this.#receiver;
        return request => receiver.handle(request);
    }

    #driver<T>(mode: DeliveryMode, context: DriverContext<T>): Driver {
        if (mode === 'poll') return new PollDriver(context, this.#floorMs);
        if (mode === 'push') return new PushDriver(context);
        // Webhook is selected only with the `webhook` option set.
        return this.#webhooks!.driver(context);
    }

    #require(method: string): EventsConnection {
        const connection = this.#connection;
        if (connection === undefined) throw new Error(`Call attach(client) before ${method}`);
        if (!this.supported) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Server does not support the ${EVENTS_EXTENSION_ID} extension (required for ${method})`
            );
        }
        return connection;
    }
}
