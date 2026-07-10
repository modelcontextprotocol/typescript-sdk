/**
 * Eager named-export surface for the era wire schemas.
 *
 * The schema DEFINITIONS live in `./buildSchemas.ts`, wrapped in a memoized
 * factory so the runtime graph (codec/registry) defers zod construction to
 * the first validation. This module keeps the historical per-name import
 * surface for tests and tooling: importing it warms the memo, and every
 * export is the SAME object the registry serves (reference identity through
 * the shared memo).
 *
 * Runtime modules must import `buildSchemas` instead — a runtime import of
 * this shim would re-eagerize construction.
 */
import { buildSchemas2026 } from './buildSchemas';

export type { Rev2026NotificationMethod, Rev2026RequestMethod } from './buildSchemas';

const s = buildSchemas2026();

export const JSONValueSchema = s.JSONValueSchema;
export const JSONObjectSchema = s.JSONObjectSchema;
export const ProgressTokenSchema = s.ProgressTokenSchema;
export const CursorSchema = s.CursorSchema;
export const RequestIdSchema = s.RequestIdSchema;
export const RoleSchema = s.RoleSchema;
export const LoggingLevelSchema = s.LoggingLevelSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskMetadataSchema = s.TaskMetadataSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const RelatedTaskMetadataSchema = s.RelatedTaskMetadataSchema;
export const RequestMetaSchema = s.RequestMetaSchema;
export const BaseRequestParamsSchema = s.BaseRequestParamsSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskAugmentedRequestParamsSchema = s.TaskAugmentedRequestParamsSchema;
export const NotificationsParamsSchema = s.NotificationsParamsSchema;
export const NotificationSchema = s.NotificationSchema;
export const IconSchema = s.IconSchema;
export const IconsSchema = s.IconsSchema;
export const BaseMetadataSchema = s.BaseMetadataSchema;
export const ImplementationSchema = s.ImplementationSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ClientTasksCapabilitySchema = s.ClientTasksCapabilitySchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ServerTasksCapabilitySchema = s.ServerTasksCapabilitySchema;
export const ClientCapabilitiesSchema = s.ClientCapabilitiesSchema;
export const ServerCapabilitiesSchema = s.ServerCapabilitiesSchema;
export const ProgressSchema = s.ProgressSchema;
export const ProgressNotificationParamsSchema = s.ProgressNotificationParamsSchema;
export const ProgressNotificationSchema = s.ProgressNotificationSchema;
export const LoggingMessageNotificationParamsSchema = s.LoggingMessageNotificationParamsSchema;
export const LoggingMessageNotificationSchema = s.LoggingMessageNotificationSchema;
export const ResourceContentsSchema = s.ResourceContentsSchema;
export const TextResourceContentsSchema = s.TextResourceContentsSchema;
export const BlobResourceContentsSchema = s.BlobResourceContentsSchema;
export const AnnotationsSchema = s.AnnotationsSchema;
export const ResourceSchema = s.ResourceSchema;
export const ResourceTemplateSchema = s.ResourceTemplateSchema;
export const ResourceListChangedNotificationSchema = s.ResourceListChangedNotificationSchema;
export const ResourceUpdatedNotificationParamsSchema = s.ResourceUpdatedNotificationParamsSchema;
export const ResourceUpdatedNotificationSchema = s.ResourceUpdatedNotificationSchema;
export const PromptArgumentSchema = s.PromptArgumentSchema;
export const PromptSchema = s.PromptSchema;
export const PromptListChangedNotificationSchema = s.PromptListChangedNotificationSchema;
export const TextContentSchema = s.TextContentSchema;
export const ImageContentSchema = s.ImageContentSchema;
export const AudioContentSchema = s.AudioContentSchema;
export const ToolUseContentSchema = s.ToolUseContentSchema;
export const EmbeddedResourceSchema = s.EmbeddedResourceSchema;
export const ResourceLinkSchema = s.ResourceLinkSchema;
export const ContentBlockSchema = s.ContentBlockSchema;
export const PromptMessageSchema = s.PromptMessageSchema;
export const ToolAnnotationsSchema = s.ToolAnnotationsSchema;
export const ToolListChangedNotificationSchema = s.ToolListChangedNotificationSchema;
export const ModelHintSchema = s.ModelHintSchema;
export const ModelPreferencesSchema = s.ModelPreferencesSchema;
export const ToolChoiceSchema = s.ToolChoiceSchema;
export const BooleanSchemaSchema = s.BooleanSchemaSchema;
export const StringSchemaSchema = s.StringSchemaSchema;
export const NumberSchemaSchema = s.NumberSchemaSchema;
export const UntitledSingleSelectEnumSchemaSchema = s.UntitledSingleSelectEnumSchemaSchema;
export const TitledSingleSelectEnumSchemaSchema = s.TitledSingleSelectEnumSchemaSchema;
export const LegacyTitledEnumSchemaSchema = s.LegacyTitledEnumSchemaSchema;
export const SingleSelectEnumSchemaSchema = s.SingleSelectEnumSchemaSchema;
export const UntitledMultiSelectEnumSchemaSchema = s.UntitledMultiSelectEnumSchemaSchema;
export const TitledMultiSelectEnumSchemaSchema = s.TitledMultiSelectEnumSchemaSchema;
export const MultiSelectEnumSchemaSchema = s.MultiSelectEnumSchemaSchema;
export const EnumSchemaSchema = s.EnumSchemaSchema;
export const PrimitiveSchemaDefinitionSchema = s.PrimitiveSchemaDefinitionSchema;
export const ElicitRequestFormParamsSchema = s.ElicitRequestFormParamsSchema;
export const ResourceTemplateReferenceSchema = s.ResourceTemplateReferenceSchema;
export const PromptReferenceSchema = s.PromptReferenceSchema;
export const RootSchema = s.RootSchema;
export const ClientCapabilities2026Schema = s.ClientCapabilities2026Schema;
export const ServerCapabilities2026Schema = s.ServerCapabilities2026Schema;
export const RequestMetaEnvelopeSchema = s.RequestMetaEnvelopeSchema;
export const ToolSchema = s.ToolSchema;
export const ToolResultContentSchema = s.ToolResultContentSchema;
export const SamplingMessageContentBlockSchema = s.SamplingMessageContentBlockSchema;
export const SamplingMessageSchema = s.SamplingMessageSchema;
export const ResultTypeSchema = s.ResultTypeSchema;
export const ResultSchema = s.ResultSchema;
export const PaginatedResultSchema = s.PaginatedResultSchema;
export const CallToolResultSchema = s.CallToolResultSchema;
export const ListToolsResultSchema = s.ListToolsResultSchema;
export const ListPromptsResultSchema = s.ListPromptsResultSchema;
export const GetPromptResultSchema = s.GetPromptResultSchema;
export const ListResourcesResultSchema = s.ListResourcesResultSchema;
export const ListResourceTemplatesResultSchema = s.ListResourceTemplatesResultSchema;
export const ReadResourceResultSchema = s.ReadResourceResultSchema;
export const CompleteResultSchema = s.CompleteResultSchema;
export const CacheableResultSchema = s.CacheableResultSchema;
export const DiscoverResultSchema = s.DiscoverResultSchema;
export const CreateMessageRequestParamsSchema = s.CreateMessageRequestParamsSchema;
export const CreateMessageRequestSchema = s.CreateMessageRequestSchema;
export const ListRootsRequestSchema = s.ListRootsRequestSchema;
export const CreateMessageResultSchema = s.CreateMessageResultSchema;
export const ListRootsResultSchema = s.ListRootsResultSchema;
export const ElicitResultSchema = s.ElicitResultSchema;
export const ElicitRequestURLParamsSchema = s.ElicitRequestURLParamsSchema;
export const ElicitRequestParamsSchema = s.ElicitRequestParamsSchema;
export const ElicitRequestSchema = s.ElicitRequestSchema;
export const InputRequestSchema = s.InputRequestSchema;
export const InputResponseSchema = s.InputResponseSchema;
export const InputRequestsSchema = s.InputRequestsSchema;
export const InputResponsesSchema = s.InputResponsesSchema;
export const InputRequiredResultSchema = s.InputRequiredResultSchema;
export const InputResponseRequestParamsSchema = s.InputResponseRequestParamsSchema;
export const CallToolRequestSchema = s.CallToolRequestSchema;
export const ListToolsRequestSchema = s.ListToolsRequestSchema;
export const ListPromptsRequestSchema = s.ListPromptsRequestSchema;
export const GetPromptRequestSchema = s.GetPromptRequestSchema;
export const ListResourcesRequestSchema = s.ListResourcesRequestSchema;
export const ListResourceTemplatesRequestSchema = s.ListResourceTemplatesRequestSchema;
export const ReadResourceRequestSchema = s.ReadResourceRequestSchema;
export const CompleteRequestSchema = s.CompleteRequestSchema;
export const DiscoverRequestSchema = s.DiscoverRequestSchema;
export const SubscriptionFilterSchema = s.SubscriptionFilterSchema;
export const SubscriptionsListenRequestSchema = s.SubscriptionsListenRequestSchema;
export const SubscriptionsListenResultMetaSchema = s.SubscriptionsListenResultMetaSchema;
export const SubscriptionsListenResultSchema = s.SubscriptionsListenResultSchema;
export const dispatchRequestSchemas = s.dispatchRequestSchemas;
export const dispatchResultSchemas = s.dispatchResultSchemas;
export const NotificationMetaSchema = s.NotificationMetaSchema;
export const SubscriptionsAcknowledgedNotificationSchema = s.SubscriptionsAcknowledgedNotificationSchema;
export const CancelledNotificationParamsSchema = s.CancelledNotificationParamsSchema;
export const CancelledNotificationSchema = s.CancelledNotificationSchema;
export const notificationSchemas2026 = s.notificationSchemas2026;
export const JSONRPCResultResponseSchema = s.JSONRPCResultResponseSchema;
export const CallToolResultResponseSchema = s.CallToolResultResponseSchema;
export const ListToolsResultResponseSchema = s.ListToolsResultResponseSchema;
export const ListPromptsResultResponseSchema = s.ListPromptsResultResponseSchema;
export const GetPromptResultResponseSchema = s.GetPromptResultResponseSchema;
export const ListResourcesResultResponseSchema = s.ListResourcesResultResponseSchema;
export const ListResourceTemplatesResultResponseSchema = s.ListResourceTemplatesResultResponseSchema;
export const ReadResourceResultResponseSchema = s.ReadResourceResultResponseSchema;
export const CompleteResultResponseSchema = s.CompleteResultResponseSchema;
export const DiscoverResultResponseSchema = s.DiscoverResultResponseSchema;
