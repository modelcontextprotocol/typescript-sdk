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
import { buildSchemas2025 } from './buildSchemas';

const s = buildSchemas2025();

export const JSONValueSchema = s.JSONValueSchema;
export const JSONObjectSchema = s.JSONObjectSchema;
export const ProgressTokenSchema = s.ProgressTokenSchema;
export const CursorSchema = s.CursorSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskMetadataSchema = s.TaskMetadataSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const RelatedTaskMetadataSchema = s.RelatedTaskMetadataSchema;
export const RequestMetaSchema = s.RequestMetaSchema;
export const BaseRequestParamsSchema = s.BaseRequestParamsSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskAugmentedRequestParamsSchema = s.TaskAugmentedRequestParamsSchema;
export const RequestSchema = s.RequestSchema;
export const NotificationsParamsSchema = s.NotificationsParamsSchema;
export const NotificationSchema = s.NotificationSchema;
export const ResultSchema = s.ResultSchema;
export const RequestIdSchema = s.RequestIdSchema;
export const EmptyResultSchema = s.EmptyResultSchema;
export const CancelledNotificationParamsSchema = s.CancelledNotificationParamsSchema;
export const CancelledNotificationSchema = s.CancelledNotificationSchema;
export const IconSchema = s.IconSchema;
export const IconsSchema = s.IconsSchema;
export const BaseMetadataSchema = s.BaseMetadataSchema;
export const ImplementationSchema = s.ImplementationSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ClientTasksCapabilitySchema = s.ClientTasksCapabilitySchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ServerTasksCapabilitySchema = s.ServerTasksCapabilitySchema;
export const ClientCapabilitiesSchema = s.ClientCapabilitiesSchema;
export const InitializeRequestParamsSchema = s.InitializeRequestParamsSchema;
export const InitializeRequestSchema = s.InitializeRequestSchema;
export const ServerCapabilitiesSchema = s.ServerCapabilitiesSchema;
export const InitializeResultSchema = s.InitializeResultSchema;
export const InitializedNotificationSchema = s.InitializedNotificationSchema;
export const PingRequestSchema = s.PingRequestSchema;
export const ProgressSchema = s.ProgressSchema;
export const ProgressNotificationParamsSchema = s.ProgressNotificationParamsSchema;
export const ProgressNotificationSchema = s.ProgressNotificationSchema;
export const PaginatedRequestParamsSchema = s.PaginatedRequestParamsSchema;
export const PaginatedRequestSchema = s.PaginatedRequestSchema;
export const PaginatedResultSchema = s.PaginatedResultSchema;
export const ResourceContentsSchema = s.ResourceContentsSchema;
export const TextResourceContentsSchema = s.TextResourceContentsSchema;
export const BlobResourceContentsSchema = s.BlobResourceContentsSchema;
export const RoleSchema = s.RoleSchema;
export const AnnotationsSchema = s.AnnotationsSchema;
export const ResourceSchema = s.ResourceSchema;
export const ResourceTemplateSchema = s.ResourceTemplateSchema;
export const ListResourcesRequestSchema = s.ListResourcesRequestSchema;
export const ListResourcesResultSchema = s.ListResourcesResultSchema;
export const ListResourceTemplatesRequestSchema = s.ListResourceTemplatesRequestSchema;
export const ListResourceTemplatesResultSchema = s.ListResourceTemplatesResultSchema;
export const ResourceRequestParamsSchema = s.ResourceRequestParamsSchema;
export const ReadResourceRequestParamsSchema = s.ReadResourceRequestParamsSchema;
export const ReadResourceRequestSchema = s.ReadResourceRequestSchema;
export const ReadResourceResultSchema = s.ReadResourceResultSchema;
export const ResourceListChangedNotificationSchema = s.ResourceListChangedNotificationSchema;
export const SubscribeRequestParamsSchema = s.SubscribeRequestParamsSchema;
export const SubscribeRequestSchema = s.SubscribeRequestSchema;
export const UnsubscribeRequestParamsSchema = s.UnsubscribeRequestParamsSchema;
export const UnsubscribeRequestSchema = s.UnsubscribeRequestSchema;
export const ResourceUpdatedNotificationParamsSchema = s.ResourceUpdatedNotificationParamsSchema;
export const ResourceUpdatedNotificationSchema = s.ResourceUpdatedNotificationSchema;
export const PromptArgumentSchema = s.PromptArgumentSchema;
export const PromptSchema = s.PromptSchema;
export const ListPromptsRequestSchema = s.ListPromptsRequestSchema;
export const ListPromptsResultSchema = s.ListPromptsResultSchema;
export const GetPromptRequestParamsSchema = s.GetPromptRequestParamsSchema;
export const GetPromptRequestSchema = s.GetPromptRequestSchema;
export const TextContentSchema = s.TextContentSchema;
export const ImageContentSchema = s.ImageContentSchema;
export const AudioContentSchema = s.AudioContentSchema;
export const ToolUseContentSchema = s.ToolUseContentSchema;
export const EmbeddedResourceSchema = s.EmbeddedResourceSchema;
export const ResourceLinkSchema = s.ResourceLinkSchema;
export const ContentBlockSchema = s.ContentBlockSchema;
export const PromptMessageSchema = s.PromptMessageSchema;
export const GetPromptResultSchema = s.GetPromptResultSchema;
export const PromptListChangedNotificationSchema = s.PromptListChangedNotificationSchema;
export const ToolAnnotationsSchema = s.ToolAnnotationsSchema;
export const ToolExecutionSchema = s.ToolExecutionSchema;
export const ToolSchema = s.ToolSchema;
export const ListToolsRequestSchema = s.ListToolsRequestSchema;
export const ListToolsResultSchema = s.ListToolsResultSchema;
export const CallToolResultSchema = s.CallToolResultSchema;
export const CallToolRequestParamsSchema = s.CallToolRequestParamsSchema;
export const CallToolRequestSchema = s.CallToolRequestSchema;
export const ToolListChangedNotificationSchema = s.ToolListChangedNotificationSchema;
export const LoggingLevelSchema = s.LoggingLevelSchema;
export const SetLevelRequestParamsSchema = s.SetLevelRequestParamsSchema;
export const SetLevelRequestSchema = s.SetLevelRequestSchema;
export const LoggingMessageNotificationParamsSchema = s.LoggingMessageNotificationParamsSchema;
export const LoggingMessageNotificationSchema = s.LoggingMessageNotificationSchema;
export const ModelHintSchema = s.ModelHintSchema;
export const ModelPreferencesSchema = s.ModelPreferencesSchema;
export const ToolChoiceSchema = s.ToolChoiceSchema;
export const ToolResultContentSchema = s.ToolResultContentSchema;
export const SamplingContentSchema = s.SamplingContentSchema;
export const SamplingMessageContentBlockSchema = s.SamplingMessageContentBlockSchema;
export const SamplingMessageSchema = s.SamplingMessageSchema;
export const CreateMessageRequestParamsSchema = s.CreateMessageRequestParamsSchema;
export const CreateMessageRequestSchema = s.CreateMessageRequestSchema;
export const CreateMessageResultSchema = s.CreateMessageResultSchema;
export const CreateMessageResultWithToolsSchema = s.CreateMessageResultWithToolsSchema;
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
export const ElicitRequestURLParamsSchema = s.ElicitRequestURLParamsSchema;
export const ElicitRequestParamsSchema = s.ElicitRequestParamsSchema;
export const ElicitRequestSchema = s.ElicitRequestSchema;
export const ElicitationCompleteNotificationParamsSchema = s.ElicitationCompleteNotificationParamsSchema;
export const ElicitationCompleteNotificationSchema = s.ElicitationCompleteNotificationSchema;
export const ElicitResultSchema = s.ElicitResultSchema;
export const ResourceTemplateReferenceSchema = s.ResourceTemplateReferenceSchema;
export const PromptReferenceSchema = s.PromptReferenceSchema;
export const CompleteRequestParamsSchema = s.CompleteRequestParamsSchema;
export const CompleteRequestSchema = s.CompleteRequestSchema;
export const CompleteResultSchema = s.CompleteResultSchema;
export const RootSchema = s.RootSchema;
export const ListRootsRequestSchema = s.ListRootsRequestSchema;
export const ListRootsResultSchema = s.ListRootsResultSchema;
export const RootsListChangedNotificationSchema = s.RootsListChangedNotificationSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskCreationParamsSchema = s.TaskCreationParamsSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskStatusSchema = s.TaskStatusSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskSchema = s.TaskSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const CreateTaskResultSchema = s.CreateTaskResultSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskStatusNotificationParamsSchema = s.TaskStatusNotificationParamsSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const TaskStatusNotificationSchema = s.TaskStatusNotificationSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const GetTaskRequestSchema = s.GetTaskRequestSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const GetTaskResultSchema = s.GetTaskResultSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const GetTaskPayloadRequestSchema = s.GetTaskPayloadRequestSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const GetTaskPayloadResultSchema = s.GetTaskPayloadResultSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ListTasksRequestSchema = s.ListTasksRequestSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const ListTasksResultSchema = s.ListTasksResultSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const CancelTaskRequestSchema = s.CancelTaskRequestSchema;
/** @deprecated Task wire vocabulary (SEP-1686) — deprecated; see the task types in `types/types.ts`. */
export const CancelTaskResultSchema = s.CancelTaskResultSchema;
export const ClientRequestSchema = s.ClientRequestSchema;
export const ClientNotificationSchema = s.ClientNotificationSchema;
export const ClientResultSchema = s.ClientResultSchema;
export const ServerRequestSchema = s.ServerRequestSchema;
export const ServerNotificationSchema = s.ServerNotificationSchema;
export const ServerResultSchema = s.ServerResultSchema;
export const CallToolResultWireSchema = s.CallToolResultWireSchema;
