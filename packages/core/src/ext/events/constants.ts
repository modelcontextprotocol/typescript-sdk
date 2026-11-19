/**
 * Wire constants for the MCP Events extension (SEP-3415).
 *
 * Runtime-neutral: this module imports nothing.
 */

/**
 * The identifier a server advertises in `ServerCapabilities.extensions`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_EXTENSION_ID = 'io.modelcontextprotocol/events';

/**
 * Lists the event types a server offers.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_LIST_METHOD = 'events/list';

/**
 * Fetches the events of one subscription since a cursor (poll delivery).
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_POLL_METHOD = 'events/poll';

/**
 * Opens a long-lived stream for one subscription (push delivery).
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_STREAM_METHOD = 'events/stream';

/**
 * Creates or refreshes a webhook subscription (webhook delivery).
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_SUBSCRIBE_METHOD = 'events/subscribe';

/**
 * Removes a webhook subscription.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_UNSUBSCRIBE_METHOD = 'events/unsubscribe';

/**
 * Confirms a push stream, carrying the granted heartbeat interval; sent again mid-stream after a gap.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_ACTIVE_NOTIFICATION = 'notifications/events/active';

/**
 * Delivers one event occurrence on a push stream.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_EVENT_NOTIFICATION = 'notifications/events/event';

/**
 * Keeps a push stream alive and advances its cursor while no events match.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_HEARTBEAT_NOTIFICATION = 'notifications/events/heartbeat';

/**
 * Reports a recoverable failure on a push stream, which stays open.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_ERROR_NOTIFICATION = 'notifications/events/error';

/**
 * Ends a push subscription from the server side.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EVENTS_TERMINATED_NOTIFICATION = 'notifications/events/terminated';

/**
 * The header carrying the subscription `id` on every webhook POST.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WEBHOOK_SUBSCRIPTION_ID_HEADER = 'X-MCP-Subscription-Id';

/**
 * The delivery modes an event type can advertise.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const DELIVERY_MODES = ['poll', 'push', 'webhook'] as const;

/**
 * The categories a server reports as `deliveryStatus.lastError`, and as `data.reason` of a callback endpoint error.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const DELIVERY_ERROR_CATEGORIES = [
    'connection_refused',
    'timeout',
    'tls_error',
    'http_4xx',
    'http_5xx',
    'challenge_failed'
] as const;
