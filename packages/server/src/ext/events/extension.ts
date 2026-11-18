import type { EventDescriptor, ListEventsResult } from '@modelcontextprotocol/core/ext/events';
import {
    EVENTS_EXTENSION_ID,
    EVENTS_LIST_METHOD,
    EVENTS_POLL_METHOD,
    EVENTS_STREAM_METHOD,
    EVENTS_SUBSCRIBE_METHOD,
    EVENTS_UNSUBSCRIBE_METHOD,
    ListEventsRequestParamsSchema,
    PollEventsRequestParamsSchema,
    StreamEventsRequestParamsSchema,
    SubscribeEventsRequestParamsSchema,
    UnsubscribeEventsRequestParamsSchema
} from '@modelcontextprotocol/core/ext/events';
import type { ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { scanXMcpHeaderDeclarations } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { McpServer } from '../../server/mcp';
import { markModernOnlyExtension } from '../../server/modernOnlyExtensions';
import { markStreamingMethod } from '../../server/streamingMethods';
import type { BufferedEvent } from './emitBuffer';
import { EmitBuffer } from './emitBuffer';
import { assertModernRequest } from './eraGate';
import { PollSource, toOccurrence } from './poll';
import { StreamSet } from './push';
import type { AnyEventDefinition, RegisteredEvent } from './registry';
import { changedSchema, deliveryModes, EventRegistry } from './registry';
import { InMemoryWebhookSubscriptionStore } from './store';
import { installTestHook } from './testHook';
import type { CheckEventDefinition, EmitOnlyEventDefinition, EmitOnlyEventHandle, EventHandle, EventInput, EventsOptions } from './types';
import type { SubscriptionRequest } from './validation';
import { SubscriptionValidator } from './validation';
import { WebhookSubscriptions } from './webhookSubscriptions';

// The live subscriptions of one delivery mode, which `remove()`, a schema change and `terminate()` end.
export interface SubscriptionSource {
    terminate(name: string, error: EventsError, subscriptionId?: string): Promise<void>;
}

// Receives each emitted event once it is buffered (`cursor` the position after it, `previous` the one before); it queues delivery and returns, never waiting on a receiver.
export type EmitFanOut = (name: string, buffered: BufferedEvent, positions: { cursor: string; previous: string }) => void | Promise<void>;

type DefaultSchema = StandardSchemaWithJSON<Record<string, unknown>>;

const EVENTS_METHODS = [EVENTS_LIST_METHOD, EVENTS_POLL_METHOD, EVENTS_STREAM_METHOD, EVENTS_SUBSCRIBE_METHOD, EVENTS_UNSUBSCRIBE_METHOD];

const NUMERIC_OPTIONS = [
    'webhookTtlMs',
    'pollSubscriptionTtlMs',
    'heartbeatMs',
    'checkIntervalMs',
    'defaultNextPollMs',
    'maxSubscriptions'
] as const;

const DEFAULT_EMIT_BUFFER_MAX_AGE_MS = 600_000;
const DEFAULT_EMIT_BUFFER_MAX_EVENTS = 10_000;
const DEFAULT_POLL_SUBSCRIPTION_TTL_MS = 300_000;
const DEFAULT_NEXT_POLL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 5000;

// Servers with an events extension attached: one per server, as SEP-3371 rejects a duplicate extension identifier.
const eventsServers = new WeakSet<McpServer>();

const ONE_PER_SERVER = 'another events extension is already attached to this server; attach one per server';

function assertPositive(name: string, value: unknown): void {
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
        throw new TypeError(`${name} must be a positive finite number (got ${String(value)})`);
    }
}

function assertOrigin(origin: string): void {
    let parsed: string | undefined;
    try {
        parsed = new URL(origin).origin;
    } catch {
        parsed = undefined;
    }
    if (parsed !== origin) {
        throw new TypeError(`trustedOrigins entries must be exact origins such as "http://127.0.0.1:9000" (got ${JSON.stringify(origin)})`);
    }
}

function assertWebhookOptions(options: EventsOptions): void {
    if ((options.webhookTtlMs === undefined) !== (options.webhookSender === undefined)) {
        throw new TypeError('set webhookTtlMs and webhookSender together, or neither');
    }
    if (options.webhookTtlMs !== undefined && options.getPrincipal === undefined) {
        throw new TypeError('webhook delivery needs getPrincipal: set it with webhookTtlMs and webhookSender');
    }
}

// The two kinds, checked at runtime for plain JavaScript as the types check them for TypeScript.
function assertKind(name: string, definition: AnyEventDefinition): void {
    const hasCheck = definition.check !== undefined;
    const filters = definition.match !== undefined || definition.transform !== undefined;
    if (definition.emitOnly === true ? hasCheck : !hasCheck || filters) {
        throw new TypeError(`event '${name}': pass check(), or emitOnly: true and call emit() on the returned handle`);
    }
}

// Stderr, so a report never corrupts a stdio transport.
function defaultOnerror(error: Error): void {
    // eslint-disable-next-line no-console -- the documented default sink for events errors
    console.warn(`[mcp-sdk] events: ${error.message}`);
}

/**
 * The MCP Events extension (SEP-3415). Register event types with
 * {@linkcode EventsExtension.registerEvent}, then call
 * {@linkcode EventsExtension.attach} on each server before connecting it; one
 * instance serves any number of servers. Events is served only on protocol
 * revision `2026-07-28` and later.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class EventsExtension {
    readonly id = EVENTS_EXTENSION_ID;
    readonly #registry = new EventRegistry();
    readonly #sources: SubscriptionSource[] = [];
    readonly #attached = new WeakSet<McpServer>();
    readonly #trustedOrigins: Set<string>;
    readonly #webhookEnabled: boolean;
    readonly #onerror: (error: Error) => void;
    readonly #buffer: EmitBuffer;
    readonly #validator: SubscriptionValidator;
    readonly #poll: PollSource;
    readonly #push: StreamSet;
    // Webhook subscriptions and delivery, in webhook mode.
    readonly #webhooks: WebhookSubscriptions | undefined;
    // Each emitted event is handed to these after it is buffered; push and webhook delivery add theirs.
    readonly #fanOuts: EmitFanOut[] = [];
    // Clears process-memory state on a simulated restart; each delivery mode adds its own.
    readonly #restarts: Array<() => void> = [];
    #generation = 1;

    /** Throws `TypeError` for an invalid option, including webhook options set only in part. */
    constructor(options: EventsOptions = {}) {
        assertWebhookOptions(options);
        for (const name of NUMERIC_OPTIONS) assertPositive(name, options[name]);
        assertPositive('emitBuffer.maxAgeMs', options.emitBuffer?.maxAgeMs);
        assertPositive('emitBuffer.maxEvents', options.emitBuffer?.maxEvents);
        for (const origin of options.trustedOrigins ?? []) assertOrigin(origin);
        this.#trustedOrigins = new Set(options.trustedOrigins);
        this.#webhookEnabled = options.webhookTtlMs !== undefined;
        this.#onerror = options.onerror ?? defaultOnerror;
        this.#buffer = new EmitBuffer({
            maxAgeMs: options.emitBuffer?.maxAgeMs ?? DEFAULT_EMIT_BUFFER_MAX_AGE_MS,
            maxEvents: options.emitBuffer?.maxEvents ?? DEFAULT_EMIT_BUFFER_MAX_EVENTS
        });
        this.#validator = new SubscriptionValidator({
            registry: this.#registry,
            webhookEnabled: this.#webhookEnabled,
            getPrincipal: options.getPrincipal,
            maxSubscriptions: options.maxSubscriptions,
            subscriptionCount: () => this.#poll.size + this.#push.size + (this.#webhooks?.size ?? 0)
        });
        this.#poll = new PollSource({
            validator: this.#validator,
            buffer: this.#buffer,
            pollSubscriptionTtlMs: options.pollSubscriptionTtlMs ?? DEFAULT_POLL_SUBSCRIPTION_TTL_MS,
            defaultNextPollMs: options.defaultNextPollMs ?? DEFAULT_NEXT_POLL_MS,
            report: error => this.#report(error)
        });
        this.#push = new StreamSet({
            validator: this.#validator,
            buffer: this.#buffer,
            heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
            checkIntervalMs: options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
            report: error => this.#report(error)
        });
        const { webhookTtlMs, webhookSender } = options;
        const webhooks =
            webhookTtlMs === undefined || webhookSender === undefined
                ? undefined
                : new WebhookSubscriptions({
                      validator: this.#validator,
                      registry: this.#registry,
                      buffer: this.#buffer,
                      sender: webhookSender,
                      store: options.webhookStore ?? new InMemoryWebhookSubscriptionStore(),
                      trustedOrigins: this.#trustedOrigins,
                      webhookTtlMs,
                      checkIntervalMs: options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
                      report: error => this.#report(error)
                  });
        this.#webhooks = webhooks;
        this.#sources.push(this.#poll, this.#push);
        this.#fanOuts.push((name, buffered, { cursor }) => this.#push.fanOut(name, buffered, cursor));
        if (webhooks !== undefined) {
            this.#sources.push(webhooks);
            this.#fanOuts.push((name, buffered, positions) => webhooks.fanOut(name, buffered, positions));
        }
        this.#restarts.push(
            () => this.#buffer.clear(),
            () => this.#poll.clear(),
            () => this.#push.closeAll(),
            () => this.#webhooks?.clear()
        );
        installTestHook(this, {
            generation: () => this.#generation,
            restart: () => {
                this.#generation += 1;
                for (const clear of this.#restarts) clear();
            },
            state: () => ({
                trustedOrigins: [...this.#trustedOrigins],
                emitBuffer: this.#buffer.sizes(),
                pollLeases: this.#poll.size,
                pushStreams: this.#push.size,
                webhookSubscriptions: this.#webhooks?.delivering ?? 0,
                webhookExpiryTimers: this.#webhooks?.size ?? 0
            }),
            addTrustedOrigin: origin => {
                assertOrigin(origin);
                this.#trustedOrigins.add(origin);
            },
            addSource: source => {
                this.#sources.push(source);
            },
            addFanOut: fanOut => {
                this.#fanOuts.push(fanOut);
            }
        });
    }

    /**
     * Serves these event types on `mcp`: registers the `events/*` methods,
     * then declares the capability. Must run before connecting. Calling it
     * again for the same server does nothing. One events extension per
     * server: attaching another one throws and leaves the server as it was,
     * as does attaching to a server that already handles one of the
     * `events/*` methods. A legacy `initialize` result does not advertise
     * Events, and `events/*` requests without a `2026-07-28` envelope are
     * answered `-32601`.
     *
     * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
     *
     * @experimental
     */
    attach(mcp: McpServer): void {
        if (this.#attached.has(mcp)) return;
        if (mcp.isConnected()) throw new Error('attach events before connecting the server');
        if (eventsServers.has(mcp)) throw new Error(ONE_PER_SERVER);
        const server = mcp.server;
        // Check before changing anything; declare the capability last, so a server never advertises events it does not serve.
        for (const method of EVENTS_METHODS) server.assertCanSetRequestHandler(method);
        server.setRequestHandler(EVENTS_LIST_METHOD, { params: ListEventsRequestParamsSchema }, (_params, ctx) => this.#list(ctx));
        server.setRequestHandler(EVENTS_POLL_METHOD, { params: PollEventsRequestParamsSchema }, (params, ctx) =>
            this.#poll.handlePoll(params, ctx)
        );
        server.setRequestHandler(EVENTS_STREAM_METHOD, { params: StreamEventsRequestParamsSchema }, (params, ctx) =>
            this.#push.open(params, ctx)
        );
        server.setRequestHandler(EVENTS_SUBSCRIBE_METHOD, { params: SubscribeEventsRequestParamsSchema }, (params, ctx) =>
            this.#webhooks === undefined ? this.#refuseWebhook(params, ctx) : this.#webhooks.subscribe(params, ctx)
        );
        server.setRequestHandler(EVENTS_UNSUBSCRIBE_METHOD, { params: UnsubscribeEventsRequestParamsSchema }, (params, ctx) =>
            this.#webhooks === undefined ? this.#refuseWebhook(params, ctx) : this.#webhooks.unsubscribe(params, ctx)
        );
        server.registerCapabilities({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
        markModernOnlyExtension(server, EVENTS_EXTENSION_ID);
        markStreamingMethod(server, EVENTS_STREAM_METHOD);
        this.#attached.add(mcp);
        eventsServers.add(mcp);
    }

    /**
     * Registers an event type: pass `check` for the default kind, or
     * `emitOnly: true` and call `emit()` on the returned handle. A mistake in
     * the definition throws `TypeError`, as does registering a name again with
     * the same schemas. Registering it with a different `inputSchema` or
     * `payloadSchema` replaces the event type and ends its live subscriptions
     * with an `unsupported` error (`reason: 'schema_changed'`).
     */
    registerEvent<I extends StandardSchemaWithJSON = DefaultSchema, P extends StandardSchemaWithJSON = DefaultSchema>(
        name: string,
        definition: EmitOnlyEventDefinition<I, P>
    ): EmitOnlyEventHandle<StandardSchemaWithJSON.InferInput<P>>;
    registerEvent<I extends StandardSchemaWithJSON = DefaultSchema, P extends StandardSchemaWithJSON = DefaultSchema>(
        name: string,
        definition: CheckEventDefinition<I, P>
    ): EventHandle;
    registerEvent(name: string, definition: AnyEventDefinition): EventHandle {
        assertKind(name, definition);
        if (deliveryModes(definition.delivery, this.#webhookEnabled).length === 0) {
            throw new TypeError(`event '${name}': delivery turns off every mode this server offers`);
        }
        const previous = this.#registry.get(name);
        let current = this.#registry.register(name, definition);
        this.#checkHeaders(current);
        if (previous !== undefined) {
            const feature = changedSchema(previous, current)!;
            this.#terminateLater(
                name,
                new EventsError('unsupported', `Event type ${feature} changed`, { feature, reason: 'schema_changed' })
            );
        }
        const assertCurrent = (): void => {
            if (this.#registry.get(name) !== current) {
                throw new Error(`event '${name}': this handle's registration was removed or replaced`);
            }
        };
        const handle: EventHandle = {
            name,
            update: changes => {
                assertCurrent();
                current = this.#registry.update(current, changes);
                if (changes.inputSchema !== undefined) this.#checkHeaders(current);
            },
            remove: () => {
                if (this.#registry.get(name) !== current) return;
                this.#registry.remove(name);
                this.#terminateLater(name, new EventsError('notFound', 'Event type removed', { kind: 'event' }));
            },
            terminate: (error, options) => this.#terminate(name, error, options?.subscriptionId)
        };
        if (definition.emitOnly !== true) return handle;
        const emitOnly: EmitOnlyEventHandle<unknown> = {
            ...handle,
            emit: async (input, options) => {
                assertCurrent();
                await this.#emit(current, input, options?.subscriptionId);
            }
        };
        return emitOnly;
    }

    // Without webhook mode the shared checks refuse every webhook request: the era gate, then `unsupported`.
    async #refuseWebhook(params: SubscriptionRequest, ctx: ServerContext): Promise<never> {
        await this.#validator.validate('webhook', params, ctx);
        throw new TypeError('webhook mode is off, yet validate() accepted a webhook request');
    }

    #list(ctx: ServerContext): ListEventsResult {
        assertModernRequest(ctx);
        return { events: this.#registry.list().map(entry => this.#describe(entry)) };
    }

    #describe(entry: RegisteredEvent): EventDescriptor {
        const { description, _meta } = entry.definition;
        return {
            name: entry.name,
            ...(description === undefined ? {} : { description }),
            delivery: entry.modes(this.#webhookEnabled),
            inputSchema: entry.inputJson,
            payloadSchema: entry.payloadJson,
            ...(_meta === undefined ? {} : { _meta })
        };
    }

    #checkHeaders(entry: RegisteredEvent): void {
        const scan = scanXMcpHeaderDeclarations(entry.inputJson);
        if (scan.valid) return;
        this.#report(
            new Error(
                `event '${entry.name}' carries an invalid x-mcp-header declaration and will be excluded by ` +
                    `conforming Streamable HTTP clients: ${scan.reason}`
            )
        );
    }

    // Validates and buffers the event, then hands it to every fan-out; nobody listening is not an error.
    async #emit(entry: RegisteredEvent, input: EventInput<unknown>, subscriptionId: string | undefined): Promise<void> {
        const occurrence = await toOccurrence(entry, input, error => this.#report(error));
        if (occurrence === undefined) return;
        const buffered: BufferedEvent = subscriptionId === undefined ? { occurrence } : { occurrence, target: subscriptionId };
        const previous = this.#buffer.append(entry.name, buffered);
        const positions = { cursor: this.#buffer.head(entry.name), previous };
        await Promise.all(
            this.#fanOuts.map(async fanOut => {
                try {
                    await fanOut(entry.name, buffered, positions);
                } catch (error) {
                    this.#report(error);
                }
            })
        );
    }

    async #terminate(name: string, error: EventsError, subscriptionId: string | undefined): Promise<void> {
        await Promise.all(this.#sources.map(source => source.terminate(name, error, subscriptionId)));
    }

    // For callers that cannot wait: a failed termination goes to onerror.
    #terminateLater(name: string, error: EventsError): void {
        this.#terminate(name, error, undefined).catch((error_: unknown) => this.#report(error_));
    }

    #report(error: unknown): void {
        try {
            this.#onerror(error instanceof Error ? error : new Error(String(error)));
        } catch {
            // A throwing onerror must not break the caller it reports for.
        }
    }
}
