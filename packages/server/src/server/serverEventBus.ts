import type { JSONRPCNotification, ServerCapabilities, SubscriptionFilter } from '@modelcontextprotocol/core-internal';

/**
 * A change event a server publishes for delivery on open `subscriptions/listen`
 * streams. Each variant maps onto exactly one notification method:
 *
 * - `tools_list_changed` → `notifications/tools/list_changed`
 * - `prompts_list_changed` → `notifications/prompts/list_changed`
 * - `resources_list_changed` → `notifications/resources/list_changed`
 * - `resource_updated` → `notifications/resources/updated` (carries the URI)
 * - `extension` → its own `method`, with `params` forwarded as-is; delivered
 *   only to subscriptions whose honored filter a {@linkcode ListenExtension}
 *   declaring that method accepts
 *
 * The bus carries the event and any forwarded notification params — the
 * entry's listen router owns subscription-id stamping and per-stream filtering.
 */
export type ServerEvent = (
    | { kind: 'tools_list_changed' }
    | { kind: 'prompts_list_changed' }
    | { kind: 'resources_list_changed' }
    | { kind: 'resource_updated'; uri: string }
    | { kind: 'extension'; method: string }
) & {
    /** Forwarded notification params; the router stamps its own subscription ID and the event's resource URI. */
    params?: JSONRPCNotification['params'];
};

/** A {@linkcode ServerEvent} published by an extension (for example the Tasks extension's status notifications). */
export type ExtensionServerEvent = Extract<ServerEvent, { kind: 'extension' }>;

/**
 * An extension point for `subscriptions/listen`: lets an extension honor its
 * own fields of the requested filter (for example the Tasks extension's
 * `notifications.taskIds`) and deliver its own notifications on the stream.
 *
 * The serving entry keeps owning the wire: ack-first, subscription-id
 * stamping, keepalive, subscription limits and teardown. Both
 * `createMcpHandler` and `serveStdio` accept a `listenExtensions` option.
 *
 * Rules the entry enforces:
 *
 * - The core filter is honored first, against the server's capabilities.
 *   An extension cannot add or change a core field
 *   (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`,
 *   `resourceSubscriptions`); such keys in its result are dropped and reported.
 * - The fields an extension honors appear in the acknowledged filter and are
 *   kept on the subscription's record; {@linkcode accepts} sees exactly them.
 * - If {@linkcode honor} throws, its fields are left out of both the ack and
 *   the subscription record (so its events are never delivered on that
 *   subscription), the error is reported through `onerror`, and the core
 *   subscription is served as usual.
 * - {@linkcode accepts} is consulted only for `extension` events whose method
 *   is in {@linkcode methods}; core change events never reach it. If it
 *   throws, the event is not delivered on that subscription and the error is
 *   reported.
 */
export interface ListenExtension {
    /** A name for error reports (for example `'io.modelcontextprotocol/tasks'`). */
    readonly name: string;
    /** The notification methods this extension delivers through listen streams. */
    readonly methods: readonly string[];
    /**
     * Check the shape of this extension's fields in the requested filter.
     * Return an error message to reject the whole listen with `-32602`
     * (a malformed field is a client error), or `undefined` when they are
     * absent or well-formed.
     */
    validate?(requested: Readonly<Record<string, unknown>>): string | undefined;
    /**
     * The fields of the requested filter this extension honors, given the
     * server's capabilities. `requested` is the raw `params.notifications`
     * object of the listen request. Return `undefined` (or an empty object)
     * to honor nothing.
     */
    honor(requested: Readonly<Record<string, unknown>>, capabilities: ServerCapabilities): Record<string, unknown> | undefined;
    /** Whether an event of one of {@linkcode methods} matches the fields this extension honored on a subscription. */
    accepts(honored: Readonly<Record<string, unknown>>, event: ExtensionServerEvent): boolean;
}

/**
 * What one subscription honors: the core filter and each extension's fields.
 * @internal
 */
export interface HonoredListen {
    /** The acknowledged filter: the core fields plus every extension's fields. */
    readonly ack: Record<string, unknown>;
    /** The honored core filter. */
    readonly core: SubscriptionFilter;
    /** The fields each extension honored (extensions that honored nothing are absent). */
    readonly extensions: ReadonlyArray<{ readonly extension: ListenExtension; readonly honored: Readonly<Record<string, unknown>> }>;
}

const CORE_FILTER_KEYS: ReadonlySet<string> = new Set([
    'toolsListChanged',
    'promptsListChanged',
    'resourcesListChanged',
    'resourceSubscriptions'
]);

/** The core change notifications `subscriptions/listen` filters itself; no extension may declare one. */
export const CORE_CHANGE_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
    'notifications/tools/list_changed',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated'
]);

/**
 * Throws when an extension declares a core change notification, or two
 * extensions declare the same method. Called when a router is built, so a
 * misconfiguration fails at startup rather than per request.
 * @internal
 */
export function assertListenExtensions(extensions: readonly ListenExtension[]): void {
    const declared = new Map<string, string>();
    for (const extension of extensions) {
        for (const method of extension.methods) {
            if (CORE_CHANGE_NOTIFICATION_METHODS.has(method)) {
                throw new Error(`listenExtensions: extension '${extension.name}' cannot declare the core notification ${method}`);
            }
            const owner = declared.get(method);
            if (owner !== undefined) {
                throw new Error(`listenExtensions: ${method} is declared by both '${owner}' and '${extension.name}'`);
            }
            declared.set(method, extension.name);
        }
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Check every extension's fields in a requested filter. Returns the first
 * error message (the entry answers `-32602`), or `undefined`.
 * @internal
 */
export function validateListenExtensions(
    requested: Readonly<Record<string, unknown>>,
    extensions: readonly ListenExtension[],
    onerror?: (error: Error) => void
): string | undefined {
    for (const extension of extensions) {
        if (extension.validate === undefined) continue;
        let message: string | undefined;
        try {
            message = extension.validate(requested);
        } catch (error) {
            onerror?.(new Error(`subscriptions/listen: extension '${extension.name}' validate() threw: ${toError(error).message}`));
            continue;
        }
        if (message !== undefined) return message;
    }
    return undefined;
}

/**
 * Honor a requested filter: the core subset first (see
 * {@linkcode honoredSubset}), then each extension's fields. See
 * {@linkcode ListenExtension} for the rules.
 * @internal
 */
export function honorListen(
    filter: SubscriptionFilter,
    requested: Readonly<Record<string, unknown>>,
    capabilities: ServerCapabilities,
    extensions: readonly ListenExtension[],
    onerror?: (error: Error) => void
): HonoredListen {
    const core = honoredSubset(filter, capabilities);
    const ack: Record<string, unknown> = { ...core };
    const honoredExtensions: Array<{ extension: ListenExtension; honored: Record<string, unknown> }> = [];
    for (const extension of extensions) {
        let result: Record<string, unknown> | undefined;
        try {
            result = extension.honor(requested, capabilities);
        } catch (error) {
            const reason = toError(error).message;
            const message = `subscriptions/listen: extension '${extension.name}' honor() threw; its fields are not honored: ${reason}`;
            onerror?.(new Error(message));
            continue;
        }
        if (result === undefined) continue;
        const honored: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result)) {
            if (value === undefined) continue;
            if (CORE_FILTER_KEYS.has(key) || Object.hasOwn(ack, key)) {
                onerror?.(new Error(`subscriptions/listen: extension '${extension.name}' cannot honor '${key}'; the field is dropped`));
                continue;
            }
            honored[key] = value;
            ack[key] = value;
        }
        if (Object.keys(honored).length > 0) honoredExtensions.push({ extension, honored });
    }
    return { ack, core, extensions: honoredExtensions };
}

/**
 * Whether a subscription accepts an event: core events go through
 * {@linkcode listenFilterAccepts}; extension events through the extensions
 * that declare the event's method and honored fields on this subscription.
 * @internal
 */
export function honoredListenAccepts(listen: HonoredListen, event: ServerEvent, onerror?: (error: Error) => void): boolean {
    if (event.kind !== 'extension') return listenFilterAccepts(listen.core, event);
    for (const { extension, honored } of listen.extensions) {
        if (!extension.methods.includes(event.method)) continue;
        try {
            if (extension.accepts(honored, event)) return true;
        } catch (error) {
            onerror?.(new Error(`subscriptions/listen: extension '${extension.name}' accepts() threw: ${toError(error).message}`));
        }
    }
    return false;
}

/**
 * The server-side change-event seam for `subscriptions/listen`.
 *
 * The serving entry (`createMcpHandler`) owns the per-stream listen router:
 * each open `subscriptions/listen` stream registers a listener via
 * `subscribe()`, and consumer code (typically via `handler.notify.*` sugar)
 * publishes change events via `publish()`. In-process servers can use the
 * default {@linkcode InMemoryServerEventBus}; multi-process deployments
 * implement this interface over their own pub/sub.
 *
 * The SDK owns wire semantics (ack-first, filtering, subscription-id
 * stamping, teardown); a `ServerEventBus` only sources the events. It MUST
 * NOT echo back to the listener that published an event when called from
 * inside that listener (no surprise here — the default delivers
 * synchronously and listeners never publish).
 */
export interface ServerEventBus {
    /**
     * Publish a change event to every registered listener.
     */
    publish(event: ServerEvent): void;
    /**
     * Register a listener; returns an idempotent unsubscribe function.
     */
    subscribe(listener: (event: ServerEvent) => void): () => void;
}

/**
 * A `ServerEventBus` backed by an in-process listener set.
 *
 * `publish()` delivers synchronously to the live listener set (a listener
 * unsubscribing itself mid-dispatch is safe; the entry's listen-router
 * listeners never unsubscribe peers). A throwing listener does not stop
 * delivery to the others.
 */
export class InMemoryServerEventBus implements ServerEventBus {
    private readonly _listeners = new Set<(event: ServerEvent) => void>();

    /**
     * @param onerror - Optional callback for errors thrown by listeners
     *   during dispatch.
     */
    constructor(private readonly onerror?: (error: Error) => void) {}

    publish(event: ServerEvent): void {
        for (const listener of this._listeners) {
            try {
                listener(event);
            } catch (error) {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    subscribe(listener: (event: ServerEvent) => void): () => void {
        this._listeners.add(listener);
        let live = true;
        return () => {
            if (!live) return;
            live = false;
            this._listeners.delete(listener);
        };
    }

    /** The number of currently registered listeners (test/introspection only — the routers track capacity via their own open-subscription set). */
    get listenerCount(): number {
        return this._listeners.size;
    }
}

/**
 * Typed publish-side facade over `bus.publish` returned by `createMcpHandler`:
 * each method publishes the corresponding {@linkcode ServerEvent}. Prefer this
 * over calling `bus.publish` directly — the names match the wire methods.
 */
export interface ServerNotifier {
    /** Publish `notifications/tools/list_changed` to every open subscription that opted in. */
    toolsChanged(): void;
    /** Publish `notifications/prompts/list_changed` to every open subscription that opted in. */
    promptsChanged(): void;
    /** Publish `notifications/resources/list_changed` to every open subscription that opted in. */
    resourcesChanged(): void;
    /** Publish `notifications/resources/updated` for `uri` to every open subscription that opted in to that URI. */
    resourceUpdated(uri: string): void;
    /**
     * Publish an extension notification (`method` with `params`) to every open
     * subscription a {@linkcode ListenExtension} declaring `method` accepts.
     */
    extension(method: string, params?: JSONRPCNotification['params']): void;
}

/** Build a {@linkcode ServerNotifier} over a bus. */
export function createServerNotifier(bus: ServerEventBus): ServerNotifier {
    return {
        toolsChanged: () => bus.publish({ kind: 'tools_list_changed' }),
        promptsChanged: () => bus.publish({ kind: 'prompts_list_changed' }),
        resourcesChanged: () => bus.publish({ kind: 'resources_list_changed' }),
        resourceUpdated: (uri: string) => bus.publish({ kind: 'resource_updated', uri }),
        extension: (method: string, params?: JSONRPCNotification['params']) =>
            bus.publish({ kind: 'extension', method, ...(params !== undefined && { params }) })
    };
}

/**
 * Whether a `subscriptions/listen` filter accepts a given change event.
 *
 * Pure: no I/O, no mutation. The filter governs ONLY the four
 * subscription-gated change types — non-gated notifications never reach the
 * bus and are not modeled here. An `extension` event never matches the core
 * filter; {@linkcode ListenExtension.accepts} decides those.
 *
 * `resource_updated` matches only when `resourceSubscriptions` is present and
 * contains the event's URI exactly (per the spec: "for these resource URIs").
 */
export function listenFilterAccepts(filter: SubscriptionFilter, event: ServerEvent): boolean {
    switch (event.kind) {
        case 'tools_list_changed': {
            return filter.toolsListChanged === true;
        }
        case 'prompts_list_changed': {
            return filter.promptsListChanged === true;
        }
        case 'resources_list_changed': {
            return filter.resourcesListChanged === true;
        }
        case 'resource_updated': {
            return filter.resourceSubscriptions !== undefined && filter.resourceSubscriptions.includes(event.uri);
        }
        case 'extension': {
            return false;
        }
    }
}

/**
 * The honored subset of a requested filter: keeps only the fields the client
 * explicitly opted in to (drops `false` and absent fields), narrowed against
 * the server's declared capabilities when supplied. The serving entry sends
 * this back in `notifications/subscriptions/acknowledged` so the ack reflects
 * what the server can actually deliver.
 *
 * - `toolsListChanged` is honored only when `capabilities.tools.listChanged`
 *   is advertised; likewise `promptsListChanged` / `resourcesListChanged`.
 * - `resourceSubscriptions` is honored only when
 *   `capabilities.resources.subscribe` is advertised.
 *
 * `capabilities` is optional on this pure helper for test convenience only —
 * both wired routers REQUIRE capabilities at the call site (the HTTP router's
 * `serve()` takes a required parameter; `StdioListenRouter.serve()` throws
 * before `setServerCapabilities()` was called), so the fail-open
 * `undefined → honor everything` branch is never reachable on a wired entry.
 */
export function honoredSubset(requested: SubscriptionFilter, capabilities?: ServerCapabilities): SubscriptionFilter {
    const honored: SubscriptionFilter = {};
    const allow = (bit: unknown): boolean => capabilities === undefined || bit === true;
    if (requested.toolsListChanged === true && allow(capabilities?.tools?.listChanged)) honored.toolsListChanged = true;
    if (requested.promptsListChanged === true && allow(capabilities?.prompts?.listChanged)) honored.promptsListChanged = true;
    if (requested.resourcesListChanged === true && allow(capabilities?.resources?.listChanged)) honored.resourcesListChanged = true;
    if (
        requested.resourceSubscriptions !== undefined &&
        requested.resourceSubscriptions.length > 0 &&
        allow(capabilities?.resources?.subscribe)
    ) {
        honored.resourceSubscriptions = [...requested.resourceSubscriptions];
    }
    return honored;
}

/** Map a {@linkcode ServerEvent} onto its wire notification `{method, params}`. */
export function serverEventToNotification(event: ServerEvent): { method: string; params?: JSONRPCNotification['params'] } {
    switch (event.kind) {
        case 'tools_list_changed': {
            return { method: 'notifications/tools/list_changed', ...(event.params !== undefined && { params: event.params }) };
        }
        case 'prompts_list_changed': {
            return { method: 'notifications/prompts/list_changed', ...(event.params !== undefined && { params: event.params }) };
        }
        case 'resources_list_changed': {
            return { method: 'notifications/resources/list_changed', ...(event.params !== undefined && { params: event.params }) };
        }
        case 'resource_updated': {
            return { method: 'notifications/resources/updated', params: { ...event.params, uri: event.uri } };
        }
        case 'extension': {
            return { method: event.method, ...(event.params !== undefined && { params: event.params }) };
        }
    }
}
