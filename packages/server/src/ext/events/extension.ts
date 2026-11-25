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

import type { ServerExtension, ServerExtensionContext } from '../../server/extension';
import { markModernOnlyExtension } from '../../server/modernOnlyExtensions';
import { registerParamHeaderSource } from '../../server/paramHeaderSources';
import { perRequestFlowOf } from '../../server/perRequestTransport';
import type { Server } from '../../server/server';
import { markStreamingMethod } from '../../server/streamingMethods';
import type { BufferedEvent } from './emitBuffer';
import { EmitBuffer } from './emitBuffer';
import { assertModernServer } from './eraGate';
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

export type DefaultSchema = StandardSchemaWithJSON<Record<string, unknown>>;

// The `events/*` requests that name an event type in `params.name`.
const NAMED_EVENT_METHODS = [EVENTS_POLL_METHOD, EVENTS_STREAM_METHOD, EVENTS_SUBSCRIBE_METHOD, EVENTS_UNSUBSCRIBE_METHOD];

const DURATION_OPTIONS = ['pollSubscriptionTtlMs', 'checkIntervalMs'] as const;
// Durations that reach clients, so whole milliseconds as the wire schemas require.
const WIRE_DURATION_OPTIONS = ['webhookTtlMs', 'heartbeatMs', 'defaultNextPollMs'] as const;

const DEFAULT_EMIT_BUFFER_MAX_AGE_MS = 600_000;
const DEFAULT_EMIT_BUFFER_MAX_EVENTS = 10_000;
const DEFAULT_POLL_SUBSCRIPTION_TTL_MS = 300_000;
const DEFAULT_NEXT_POLL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 5000;
// As `createMcpHandler` bounds `subscriptions/listen` streams.
const DEFAULT_MAX_SUBSCRIPTIONS = 1024;

function assertPositive(name: string, value: unknown): void {
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
        throw new TypeError(`${name} must be a positive finite number (got ${String(value)})`);
    }
}

function assertCount(name: string, value: unknown): void {
    if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value > 0)) {
        throw new TypeError(`${name} must be a positive integer (got ${String(value)})`);
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

// A poll client that waits a `defaultNextPollMs` set explicitly must find its lease still there; a defaulted one is capped per result.
function assertPollTiming(pollSubscriptionTtlMs: number, defaultNextPollMs: number | undefined): void {
    if (defaultNextPollMs !== undefined && defaultNextPollMs > Math.floor(pollSubscriptionTtlMs / 2)) {
        throw new TypeError(
            `defaultNextPollMs (${defaultNextPollMs}) must be at most half of pollSubscriptionTtlMs (${pollSubscriptionTtlMs})`
        );
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
 * {@linkcode EventsExtension.registerEvent}, and pass the extension in each
 * server's `extensions` option (`new McpServer(info, { extensions: [events] })`);
 * one instance serves any number of servers. Events is served only on protocol
 * revision `2026-07-28` and later.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class EventsExtension implements ServerExtension {
    readonly id = EVENTS_EXTENSION_ID;
    readonly #registry = new EventRegistry();
    readonly #sources: SubscriptionSource[] = [];
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
        for (const name of DURATION_OPTIONS) assertPositive(name, options[name]);
        for (const name of WIRE_DURATION_OPTIONS) assertCount(name, options[name]);
        assertCount('maxSubscriptions', options.maxSubscriptions);
        assertPositive('emitBuffer.maxAgeMs', options.emitBuffer?.maxAgeMs);
        assertCount('emitBuffer.maxEvents', options.emitBuffer?.maxEvents);
        const pollSubscriptionTtlMs = options.pollSubscriptionTtlMs ?? DEFAULT_POLL_SUBSCRIPTION_TTL_MS;
        assertPollTiming(pollSubscriptionTtlMs, options.defaultNextPollMs);
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
            maxSubscriptions: options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
            subscriptionCount: () => this.#poll.size + this.#push.size + (this.#webhooks?.size ?? 0),
            principalSubscriptionCount: principal =>
                this.#poll.countOf(principal) + this.#push.countOf(principal) + (this.#webhooks?.countOf(principal) ?? 0)
        });
        this.#poll = new PollSource({
            validator: this.#validator,
            buffer: this.#buffer,
            pollSubscriptionTtlMs,
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
                webhookExpiryTimers: this.#webhooks?.watching ?? 0
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
     * Serves these event types on a server that lists this extension in
     * `extensions`: the server calls it once, while it is constructed, and
     * advertises the extension as `{}`. A legacy `initialize` result does not
     * advertise Events, and a server serving an earlier revision than
     * `2026-07-28` answers `events/*` requests with `-32601`.
     */
    setup(ctx: ServerExtensionContext): void {
        const server = ctx.mcp.server;
        ctx.setRequestHandler(EVENTS_LIST_METHOD, { params: ListEventsRequestParamsSchema }, (_params, requestCtx) =>
            this.#modernOnly(server, () => this.#list(requestCtx))
        );
        ctx.setRequestHandler(EVENTS_POLL_METHOD, { params: PollEventsRequestParamsSchema }, (params, requestCtx) =>
            this.#modernOnly(server, () => this.#poll.handlePoll(params, requestCtx))
        );
        ctx.setRequestHandler(EVENTS_STREAM_METHOD, { params: StreamEventsRequestParamsSchema }, (params, requestCtx) =>
            this.#modernOnly(server, () => this.#push.open(params, requestCtx, perRequestFlowOf(server.transport)))
        );
        ctx.setRequestHandler(EVENTS_SUBSCRIBE_METHOD, { params: SubscribeEventsRequestParamsSchema }, (params, requestCtx) =>
            this.#modernOnly(server, () =>
                this.#webhooks === undefined ? this.#refuseWebhook(params, requestCtx) : this.#webhooks.subscribe(params, requestCtx)
            )
        );
        ctx.setRequestHandler(EVENTS_UNSUBSCRIBE_METHOD, { params: UnsubscribeEventsRequestParamsSchema }, (params, requestCtx) =>
            this.#modernOnly(server, () =>
                this.#webhooks === undefined ? this.#refuseWebhook(params, requestCtx) : this.#webhooks.unsubscribe(params, requestCtx)
            )
        );
        markModernOnlyExtension(server, EVENTS_EXTENSION_ID);
        markStreamingMethod(server, EVENTS_STREAM_METHOD);
        registerParamHeaderSource(ctx.mcp, NAMED_EVENT_METHODS, name => this.#registry.get(name)?.inputJson);
    }

    /**
     * Registers an event type: pass `check` for the default kind, or
     * `emitOnly: true` and call `emit()` on the returned handle. A mistake in
     * the definition throws `TypeError`, as does registering a name again with
     * the same schemas; a schema that cannot be converted to JSON Schema
     * throws an `Error`. Registering it with a different `inputSchema` or
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
            // Buffered events have the replaced schemas; their cursors read as a gap from now on.
            this.#buffer.drop(name);
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
                const previous = current;
                current = this.#registry.update(current, changes);
                this.#push.update(previous, current);
                this.#webhooks?.update(previous, current);
                if (changes.inputSchema !== undefined) this.#checkHeaders(current);
            },
            remove: () => {
                if (this.#registry.get(name) !== current) return;
                this.#registry.remove(name);
                this.#buffer.drop(name);
                this.#terminateLater(name, new EventsError('notFound', 'Event type removed', { kind: 'event' }));
            },
            terminate: (error, options) => this.#terminate(name, error, options?.subscriptionId)
        };
        if (definition.emitOnly !== true) return handle;
        const emitOnly: EmitOnlyEventHandle<unknown> = {
            ...handle,
            emit: async input => {
                assertCurrent();
                await this.#emit(current, input);
            }
        };
        return emitOnly;
    }

    // Runs `serve` only on a server bound to 2026-07-28 or later; the request's `_meta` envelope does not decide.
    #modernOnly<T>(server: Server, serve: () => T): T {
        assertModernServer(server);
        return serve();
    }

    // Without webhook mode the shared checks refuse every webhook request with `unsupported`.
    async #refuseWebhook(params: SubscriptionRequest, ctx: ServerContext): Promise<never> {
        await this.#validator.validate('webhook', params, ctx);
        throw new TypeError('webhook mode is off, yet validate() accepted a webhook request');
    }

    // Webhook is listed only to a caller with a principal, who can use it; a type left without a mode is left out.
    async #list(ctx: ServerContext): Promise<ListEventsResult> {
        const webhook = this.#webhookEnabled && (await this.#validator.principalOf(ctx)) !== null;
        return {
            events: this.#registry
                .list()
                .map(entry => this.#describe(entry, webhook))
                .filter(descriptor => descriptor.delivery.length > 0)
        };
    }

    #describe(entry: RegisteredEvent, webhook: boolean): EventDescriptor {
        const { description, _meta } = entry.definition;
        return {
            name: entry.name,
            ...(description === undefined ? {} : { description }),
            delivery: entry.modes(webhook),
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
    async #emit(entry: RegisteredEvent, input: EventInput<unknown>): Promise<void> {
        const occurrence = await toOccurrence(entry, input, error => this.#report(error));
        if (occurrence === undefined) return;
        const buffered: BufferedEvent = { occurrence };
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
