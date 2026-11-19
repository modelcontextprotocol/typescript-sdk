import type * as z from 'zod/v4';

import type {
    DeliveryErrorCategorySchema,
    DeliveryModeSchema,
    DeliveryStatusSchema,
    EventDescriptorSchema,
    EventNotificationParamsSchema,
    EventOccurrenceSchema,
    EventsActiveNotificationParamsSchema,
    EventsCapabilitySchema,
    EventsErrorNotificationParamsSchema,
    EventsErrorObjectSchema,
    EventsHeartbeatNotificationParamsSchema,
    EventsTerminatedNotificationParamsSchema,
    ListEventsRequestParamsSchema,
    ListEventsResultSchema,
    PollEventsRequestParamsSchema,
    PollEventsResultSchema,
    StreamEventsRequestParamsSchema,
    StreamEventsResultSchema,
    SubscribeEventsRequestParamsSchema,
    SubscribeEventsResultSchema,
    UnsubscribeEventsRequestParamsSchema,
    UnsubscribeEventsResultSchema,
    WebhookControlBodySchema,
    WebhookDeliverySchema,
    WebhookGapBodySchema,
    WebhookTargetSchema,
    WebhookTerminatedBodySchema,
    WebhookVerificationBodySchema
} from './schemas';

/**
 * `poll`, `push` or `webhook`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

/**
 * A webhook delivery failure category.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type DeliveryErrorCategory = z.infer<typeof DeliveryErrorCategorySchema>;

/**
 * An event type as `events/list` describes it.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventDescriptor = z.infer<typeof EventDescriptorSchema>;

/**
 * One delivered event.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventOccurrence = z.infer<typeof EventOccurrenceSchema>;

/**
 * The error object Events carries in notifications and the webhook `terminated` body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsErrorObject = z.infer<typeof EventsErrorObjectSchema>;

/**
 * Params of `events/list`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type ListEventsRequestParams = z.infer<typeof ListEventsRequestParamsSchema>;

/**
 * Result of `events/list`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type ListEventsResult = z.infer<typeof ListEventsResultSchema>;

/**
 * Params of `events/poll`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type PollEventsRequestParams = z.infer<typeof PollEventsRequestParamsSchema>;

/**
 * Result of `events/poll`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type PollEventsResult = z.infer<typeof PollEventsResultSchema>;

/**
 * Params of `events/stream`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type StreamEventsRequestParams = z.infer<typeof StreamEventsRequestParamsSchema>;

/**
 * Result of `events/stream`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type StreamEventsResult = z.infer<typeof StreamEventsResultSchema>;

/**
 * The `delivery` object of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

/**
 * The `delivery` object of `events/unsubscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookTarget = z.infer<typeof WebhookTargetSchema>;

/**
 * Params of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type SubscribeEventsRequestParams = z.infer<typeof SubscribeEventsRequestParamsSchema>;

/**
 * Result of `events/subscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type SubscribeEventsResult = z.infer<typeof SubscribeEventsResultSchema>;

/**
 * Webhook delivery health, as an `events/subscribe` refresh may report it.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/**
 * Params of `events/unsubscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type UnsubscribeEventsRequestParams = z.infer<typeof UnsubscribeEventsRequestParamsSchema>;

/**
 * Result of `events/unsubscribe`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type UnsubscribeEventsResult = z.infer<typeof UnsubscribeEventsResultSchema>;

/**
 * Params of `notifications/events/active`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsActiveNotificationParams = z.infer<typeof EventsActiveNotificationParamsSchema>;

/**
 * Params of `notifications/events/event`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventNotificationParams = z.infer<typeof EventNotificationParamsSchema>;

/**
 * Params of `notifications/events/heartbeat`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsHeartbeatNotificationParams = z.infer<typeof EventsHeartbeatNotificationParamsSchema>;

/**
 * Params of `notifications/events/error`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsErrorNotificationParams = z.infer<typeof EventsErrorNotificationParamsSchema>;

/**
 * Params of `notifications/events/terminated`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsTerminatedNotificationParams = z.infer<typeof EventsTerminatedNotificationParamsSchema>;

/**
 * Webhook `gap` control body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookGapBody = z.infer<typeof WebhookGapBodySchema>;

/**
 * Webhook `terminated` control body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookTerminatedBody = z.infer<typeof WebhookTerminatedBodySchema>;

/**
 * Webhook `verification` control body.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookVerificationBody = z.infer<typeof WebhookVerificationBodySchema>;

/**
 * Any webhook control body, discriminated on `type`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type WebhookControlBody = z.infer<typeof WebhookControlBodySchema>;

/**
 * The value at `capabilities.extensions["io.modelcontextprotocol/events"]`.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsCapability = z.infer<typeof EventsCapabilitySchema>;
