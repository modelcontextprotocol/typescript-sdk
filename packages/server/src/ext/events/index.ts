// @modelcontextprotocol/server/ext/events
//
// Server side of the MCP Events extension (SEP-3415).

export { EventsExtension } from './extension';
export { InMemoryWebhookSubscriptionStore } from './store';
export type {
    CheckContext,
    CheckEventDefinition,
    EmitOnlyEventDefinition,
    EmitOnlyEventHandle,
    EventContext,
    EventDefinition,
    EventHandle,
    EventInput,
    EventResult,
    EventsOptions,
    WebhookSender,
    WebhookSendOutcome,
    WebhookSendRequest,
    WebhookSubscriptionRecord,
    WebhookSubscriptionStore
} from './types';
export type {
    DeliveryErrorCategory,
    DeliveryMode,
    DeliveryStatus,
    EventDescriptor,
    EventNotificationParams,
    EventOccurrence,
    EventsActiveNotificationParams,
    EventsCapability,
    EventsErrorNotificationParams,
    EventsErrorObject,
    EventsHeartbeatNotificationParams,
    EventsTerminatedNotificationParams,
    ListEventsRequestParams,
    ListEventsResult,
    PollEventsRequestParams,
    PollEventsResult,
    StreamEventsRequestParams,
    StreamEventsResult,
    SubscribeEventsRequestParams,
    SubscribeEventsResult,
    UnsubscribeEventsRequestParams,
    UnsubscribeEventsResult,
    WebhookControlBody,
    WebhookDelivery,
    WebhookGapBody,
    WebhookTarget,
    WebhookTerminatedBody,
    WebhookVerificationBody
} from '@modelcontextprotocol/core/ext/events';
export {
    DELIVERY_ERROR_CATEGORIES,
    DELIVERY_MODES,
    EVENTS_ACTIVE_NOTIFICATION,
    EVENTS_ERROR_NOTIFICATION,
    EVENTS_EVENT_NOTIFICATION,
    EVENTS_EXTENSION_ID,
    EVENTS_HEARTBEAT_NOTIFICATION,
    EVENTS_LIST_METHOD,
    EVENTS_POLL_METHOD,
    EVENTS_STREAM_METHOD,
    EVENTS_SUBSCRIBE_METHOD,
    EVENTS_TERMINATED_NOTIFICATION,
    EVENTS_UNSUBSCRIBE_METHOD,
    WEBHOOK_SUBSCRIPTION_ID_HEADER
} from '@modelcontextprotocol/core/ext/events';
export type { EventsErrorKind } from '@modelcontextprotocol/core-internal/ext/events';
export { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
