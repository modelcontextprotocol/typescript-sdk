import * as z from 'zod/v4';

import { BaseRequestParamsSchema, PaginatedRequestParamsSchema, PaginatedResultSchema, ResultSchema } from '../../schemas';
import { DELIVERY_ERROR_CATEGORIES, DELIVERY_MODES } from './constants';

// Every object schema here is loose, so unknown keys survive; an absent `cursor` means the same as `null` (SEP-3415).

const cursor = z.string().nullable().optional();
const meta = z.record(z.string(), z.unknown()).optional();
const jsonObject = z.record(z.string(), z.unknown());

/**
 * One of `poll`, `push`, `webhook`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const DeliveryModeSchema = z.enum(DELIVERY_MODES);

/**
 * One of the six webhook delivery failure categories.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const DeliveryErrorCategorySchema = z.enum(DELIVERY_ERROR_CATEGORIES);

/**
 * An event type as `events/list` describes it.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventDescriptorSchema = z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    /** The delivery modes the event type supports; never empty. */
    delivery: z.array(DeliveryModeSchema).min(1),
    /** JSON Schema for the subscription `arguments`. */
    inputSchema: jsonObject,
    /** JSON Schema for `data` in delivered events. */
    payloadSchema: jsonObject,
    _meta: meta
});

/**
 * One delivered event: a poll result entry, the params of `notifications/events/event`, or a webhook event body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventOccurrenceSchema = z.looseObject({
    /** Stable identifier of the upstream event, for deduplication within a subscription. */
    eventId: z.string(),
    name: z.string(),
    /** ISO 8601 time the event occurred. */
    timestamp: z.string(),
    /** Payload conforming to the event type's `payloadSchema`. */
    data: jsonObject,
    /** Subscription position after this event (push and webhook); `null` without replay. */
    cursor,
    _meta: meta
});

/**
 * The error object of `notifications/events/error`, `notifications/events/terminated` and the webhook `terminated` body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsErrorObjectSchema = z.looseObject({
    code: z.number().int(),
    message: z.string(),
    data: jsonObject.optional()
});

/**
 * Params of `events/list`: the pagination params every list request takes.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
// eslint-disable-next-line unicorn/prefer-export-from -- a bare re-export cannot carry the experimental JSDoc
export const ListEventsRequestParamsSchema = PaginatedRequestParamsSchema;

/**
 * Result of `events/list`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const ListEventsResultSchema = z.looseObject({
    ...PaginatedResultSchema.shape,
    events: z.array(EventDescriptorSchema)
});

const subscriptionRequestFields = {
    ...BaseRequestParamsSchema.shape,
    /** The event type name. */
    name: z.string(),
    /** Subscription arguments, valid against the event type's `inputSchema`. */
    arguments: jsonObject.optional(),
    /** Where to start: `null` (or absent) means now. */
    cursor,
    /** Do not replay events older than this many milliseconds. */
    maxAgeMs: z.number().int().nonnegative().optional()
};

/**
 * Params of `events/poll`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const PollEventsRequestParamsSchema = z.looseObject({
    ...subscriptionRequestFields,
    /** Cap on the number of events returned. */
    maxEvents: z.number().int().min(1).optional()
});

/**
 * Result of `events/poll`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const PollEventsResultSchema = z.looseObject({
    ...ResultSchema.shape,
    events: z.array(EventOccurrenceSchema),
    /** The position to poll from next; `null` without replay. */
    cursor,
    /** Whether events were skipped between the supplied cursor and this batch. */
    truncated: z.boolean().optional(),
    /** Whether more events are ready now; poll again at once, ignoring `nextPollMs`. */
    hasMore: z.boolean().optional(),
    /** The recommended wait before the next poll. */
    nextPollMs: z.number().int().nonnegative().optional()
});

/**
 * Params of `events/stream`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const StreamEventsRequestParamsSchema = z.looseObject({
    ...subscriptionRequestFields,
    /** Suggested heartbeat interval; the server's grant in `notifications/events/active` is authoritative. */
    heartbeatMs: z.number().int().min(1).optional()
});

/**
 * Result of `events/stream`: the empty final frame when the server closes the stream.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const StreamEventsResultSchema = z.looseObject(ResultSchema.shape);

/**
 * The `delivery` object of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookDeliverySchema = z.looseObject({
    mode: z.literal('webhook'),
    /** The `https` callback URL the server POSTs to. */
    url: z.string(),
    /** The Standard Webhooks signing secret: `whsec_` followed by base64 of 24 to 64 random bytes. */
    secret: z.string()
});

/**
 * The `delivery` object of `events/unsubscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookTargetSchema = z.looseObject({
    /** The callback URL of the subscription to remove. */
    url: z.string()
});

/**
 * Params of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const SubscribeEventsRequestParamsSchema = z.looseObject({
    ...subscriptionRequestFields,
    delivery: WebhookDeliverySchema,
    /** Suggested lifetime: absent asks for the server default, `null` for no expiry. */
    ttlMs: z.number().int().nonnegative().nullable().optional()
});

/**
 * Webhook delivery health, as an `events/subscribe` refresh may report it.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const DeliveryStatusSchema = z.looseObject({
    /** Whether the server is delivering; `false` means retries were suspended until this refresh. */
    active: z.boolean(),
    lastDeliveryAt: z.string().nullable().optional(),
    lastError: DeliveryErrorCategorySchema.nullable().optional(),
    failedSince: z.string().optional(),
    /** Whether the server is rate-limiting deliveries (delayed, not failing). */
    throttled: z.boolean().optional(),
    retryAfterMs: z.number().int().nonnegative().optional()
});

/**
 * Result of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const SubscribeEventsResultSchema = z.looseObject({
    ...ResultSchema.shape,
    /** Server-derived subscription id, sent as `X-MCP-Subscription-Id` on every delivery. */
    id: z.string(),
    /** ISO 8601 time to refresh before; `null` grants no expiry. */
    refreshBefore: z.string().nullable(),
    /** Safe-to-persist watermark; `null` without replay. */
    cursor,
    truncated: z.boolean().optional(),
    deliveryStatus: DeliveryStatusSchema.optional()
});

/**
 * Params of `events/unsubscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const UnsubscribeEventsRequestParamsSchema = z.looseObject({
    ...BaseRequestParamsSchema.shape,
    name: z.string(),
    arguments: jsonObject.optional(),
    delivery: WebhookTargetSchema
});

/**
 * Result of `events/unsubscribe`: an empty result.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const UnsubscribeEventsResultSchema = z.looseObject(ResultSchema.shape);

/**
 * Params of `notifications/events/active`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsActiveNotificationParamsSchema = z.looseObject({
    cursor,
    truncated: z.boolean().optional(),
    /** The granted heartbeat interval. */
    heartbeatMs: z.number().int().min(1),
    _meta: meta
});

/**
 * Params of `notifications/events/event`: one event occurrence.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventNotificationParamsSchema = EventOccurrenceSchema;

/**
 * Params of `notifications/events/heartbeat`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsHeartbeatNotificationParamsSchema = z.looseObject({
    /** The position the server has checked up to. */
    cursor,
    _meta: meta
});

const errorNotificationFields = {
    error: EventsErrorObjectSchema,
    _meta: meta
};

/**
 * Params of `notifications/events/error`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsErrorNotificationParamsSchema = z.looseObject(errorNotificationFields);

/**
 * Params of `notifications/events/terminated`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsTerminatedNotificationParamsSchema = z.looseObject(errorNotificationFields);

/**
 * Webhook control body: a gap between refreshes, with the fresh cursor to persist.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookGapBodySchema = z.looseObject({
    type: z.literal('gap'),
    cursor
});

/**
 * Webhook control body: the subscription has ended.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookTerminatedBodySchema = z.looseObject({
    type: z.literal('terminated'),
    error: EventsErrorObjectSchema
});

/**
 * Webhook control body: the endpoint verification challenge, echoed back in a `2xx` body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookVerificationBodySchema = z.looseObject({
    type: z.literal('verification'),
    challenge: z.string()
});

/**
 * Any webhook control body; a webhook body without a top-level `type` is an event occurrence.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const WebhookControlBodySchema = z.discriminatedUnion('type', [
    WebhookGapBodySchema,
    WebhookTerminatedBodySchema,
    WebhookVerificationBodySchema
]);

/**
 * The value at `capabilities.extensions["io.modelcontextprotocol/events"]`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export const EventsCapabilitySchema = z.looseObject({
    /** Whether the server sends `notifications/events/list_changed`. */
    listChanged: z.boolean().optional()
});
