import type { DeliveryMode, ListEventsResult } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_EXTENSION_ID, EVENTS_LIST_METHOD, eventsCapabilityOf } from '@modelcontextprotocol/core/ext/events';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import type { Client } from '../../client/client';
import { NoCompatibleDeliveryModeError } from './errors';
import { PollDriver } from './poll';
import { EventsConnection } from './request';
import type { Driver, DriverContext, EventSubscription, SubscribeOptions } from './subscription';
import { SubscriptionQueue } from './subscription';

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
     * Webhook delivery: the callback URL the server POSTs events to, and
     * optionally the source of each subscription's `whsec_` signing secret.
     * With it set, a subscription prefers webhook where the event type offers it.
     */
    webhook?: { url: string; secretProvider?: () => string };
    /** The shortest wait between two polls, whatever `nextPollMs` the server recommends. Default 1000. */
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
    #connection: EventsConnection | undefined;

    /** @throws {TypeError} when `pollIntervalFloorMs` is not a positive finite number. */
    constructor(options: EventsClientOptions = {}) {
        const floorMs = options.pollIntervalFloorMs ?? DEFAULT_POLL_INTERVAL_FLOOR_MS;
        if (!(Number.isFinite(floorMs) && floorMs > 0)) {
            throw new TypeError(`pollIntervalFloorMs must be a positive finite number (got ${String(floorMs)})`);
        }
        this.#options = options;
        this.#floorMs = floorMs;
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
     * `events/poll` response). A transient failure of that exchange (a
     * transport error, or a JSON-RPC error that is not an Events kind) does
     * not reject: delivery is retried in the background. A `cursor` the
     * server refuses because the event type's schema changed is dropped: the
     * event types are listed again, the subscription starts from now, and
     * `onGap` reports the fresh cursor. Once subscribed, the server ending the
     * subscription ends its loop (see {@linkcode EventSubscription}).
     *
     * @throws {EventsError} when the server refuses the subscription: `notFound` for an event type it does not list or
     *   no longer serves, `invalidParams` for arguments its `inputSchema` rejects, `forbidden`, or another kind.
     * @throws {NoCompatibleDeliveryModeError} when no delivery mode the event type offers is usable here, also when
     *   the schema change that refused `cursor` left the event type without the selected mode.
     * @throws {SdkError} `CapabilityNotSupported` when {@linkcode EventsClientExtension.supported} is `false`,
     *   `ConnectionClosed` when the client closes before the first exchange answers, or another code when that
     *   exchange fails in the SDK (for example a request timeout).
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

    #driver<T>(mode: DeliveryMode, context: DriverContext<T>): Driver {
        if (mode === 'poll') return new PollDriver(context, this.#floorMs);
        throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${mode} delivery is not available yet`);
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
