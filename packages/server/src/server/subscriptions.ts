import type {
    JSONRPCNotification,
    ListenContext,
    ListenStream,
    RequestId,
    ServerCapabilities,
    SubscriptionFilter,
    SubscriptionsListenRequest
} from '@modelcontextprotocol/core';
import { AsyncQueue, JSONRPC_VERSION, META_KEYS } from '@modelcontextprotocol/core';

/**
 * Kinds of server-side change a {@linkcode SubscriptionBackend} can deliver.
 */
export type SubscriptionEvent =
    | { type: 'toolsListChanged' }
    | { type: 'promptsListChanged' }
    | { type: 'resourcesListChanged' }
    | { type: 'resourceUpdated'; uri: string };

/**
 * Backend for `subscriptions/listen`. The transport adapter routes the
 * `subscriptions/listen` request here (NOT through the Dispatcher) and wraps
 * the returned stream in wire format. `Server.send*ListChanged` calls
 * {@linkcode notify} to deliver events to all active listeners.
 *
 * `subscriptions/listen` is the one 2026-06 method that is request→stream
 * rather than request→response, so it lives outside the Dispatcher's
 * always-short-lived contract.
 */
export interface SubscriptionBackend {
    /**
     * Opens a listen stream. Computes the accepted filter (intersection of
     * requested + server capabilities + authorization), emits the ack
     * notification, then streams matching events until `close()` is called.
     */
    handle(request: SubscriptionsListenRequest & { id: RequestId }, ctx: ListenContext, capabilities: ServerCapabilities): ListenStream;

    /**
     * Delivers an event to all active listeners whose filter matches.
     * Distributed implementations may await broker delivery.
     */
    notify(event: SubscriptionEvent): Promise<void>;
}

const MAX_QUEUE = 256;
const MAX_RESOURCE_SUBSCRIPTIONS = 256;

type ListenerEntry = {
    subscriptionId: string;
    filter: SubscriptionFilter;
    resourceSubscriptions?: ReadonlySet<string>;
    queue: AsyncQueue<JSONRPCNotification>;
};

/**
 * In-memory {@linkcode SubscriptionBackend}. Suitable for single-process
 * deployments; horizontally-scaled deployments should provide a distributed
 * implementation (e.g., Redis pub/sub).
 */
export class InMemorySubscriptions implements SubscriptionBackend {
    private readonly _active = new Map<string, ListenerEntry>();

    handle(request: SubscriptionsListenRequest & { id: RequestId }, ctx: ListenContext, capabilities: ServerCapabilities): ListenStream {
        const requested = request.params.notifications;
        const accepted = acceptedFilter(requested, capabilities, ctx);
        // SEP-2575: the wire `_meta.subscriptionId` is the JSON-RPC id of the
        // listen request. The internal `_active` map is keyed by a
        // server-minted UUID so concurrent listeners on a shared Server
        // instance cannot collide on client-chosen ids.
        const subscriptionId = String(request.id);
        const activeKey = crypto.randomUUID();

        // Evict slow consumers at MAX_QUEUE rather than buffering unbounded server memory.
        const queue = new AsyncQueue<JSONRPCNotification>(MAX_QUEUE);
        const close = (): void => {
            queue.close();
            this._active.delete(activeKey);
        };

        this._active.set(activeKey, {
            subscriptionId,
            filter: accepted,
            resourceSubscriptions: accepted.resourceSubscriptions ? new Set(accepted.resourceSubscriptions) : undefined,
            queue
        });

        // First message on the stream is always the ack.
        queue.push({
            jsonrpc: JSONRPC_VERSION,
            method: 'notifications/subscriptions/acknowledged',
            params: { notifications: accepted, _meta: { [META_KEYS.subscriptionId]: subscriptionId } }
        });

        return { stream: queue.iterate(), close };
    }

    async notify(event: SubscriptionEvent): Promise<void> {
        for (const [key, entry] of this._active) {
            const n = matchEvent(event, entry);
            if (n && !entry.queue.push(n)) this._active.delete(key);
        }
    }
}

function acceptedFilter(requested: SubscriptionFilter, caps: ServerCapabilities, ctx: ListenContext): SubscriptionFilter {
    const out: SubscriptionFilter = {};
    if (requested.toolsListChanged && caps.tools?.listChanged) out.toolsListChanged = true;
    if (requested.promptsListChanged && caps.prompts?.listChanged) out.promptsListChanged = true;
    if (requested.resourcesListChanged && caps.resources?.listChanged) out.resourcesListChanged = true;
    // resourceSubscriptions: fail-closed. Denied entirely without an authorization
    // hook. Capped before iterating so a large client array cannot amplify into
    // unbounded auth-hook calls.
    const authorize = ctx.onAuthorizeResourceSubscription;
    if (requested.resourceSubscriptions && caps.resources?.subscribe && authorize) {
        const allowed = requested.resourceSubscriptions
            .slice(0, MAX_RESOURCE_SUBSCRIPTIONS)
            .filter(uri => authorize(uri, { authInfo: ctx.authInfo }));
        if (allowed.length > 0) out.resourceSubscriptions = allowed;
    }
    return out;
}

function matchEvent(event: SubscriptionEvent, entry: ListenerEntry): JSONRPCNotification | undefined {
    const _meta = { [META_KEYS.subscriptionId]: entry.subscriptionId };
    switch (event.type) {
        case 'toolsListChanged': {
            return entry.filter.toolsListChanged
                ? { jsonrpc: JSONRPC_VERSION, method: 'notifications/tools/list_changed', params: { _meta } }
                : undefined;
        }
        case 'promptsListChanged': {
            return entry.filter.promptsListChanged
                ? { jsonrpc: JSONRPC_VERSION, method: 'notifications/prompts/list_changed', params: { _meta } }
                : undefined;
        }
        case 'resourcesListChanged': {
            return entry.filter.resourcesListChanged
                ? { jsonrpc: JSONRPC_VERSION, method: 'notifications/resources/list_changed', params: { _meta } }
                : undefined;
        }
        case 'resourceUpdated': {
            return entry.resourceSubscriptions?.has(event.uri)
                ? { jsonrpc: JSONRPC_VERSION, method: 'notifications/resources/updated', params: { uri: event.uri, _meta } }
                : undefined;
        }
    }
}
