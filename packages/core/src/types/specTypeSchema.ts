import type * as z from 'zod/v4';

import {
    OAuthClientInformationFullSchema,
    OAuthClientInformationSchema,
    OAuthClientMetadataSchema,
    OAuthClientRegistrationErrorSchema,
    OAuthErrorResponseSchema,
    OAuthMetadataSchema,
    OAuthProtectedResourceMetadataSchema,
    OAuthTokenRevocationRequestSchema,
    OAuthTokensSchema,
    OpenIdProviderDiscoveryMetadataSchema,
    OpenIdProviderMetadataSchema
} from '../shared/auth.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import * as schemas from './schemas.js';

/**
 * Explicit allowlist of protocol Zod schemas that correspond to a public spec type in `types.ts`.
 *
 * This intentionally excludes internal helper schemas exported from `schemas.ts` that have no
 * matching public type (e.g. `ListChangedOptionsBaseSchema`, `BaseRequestParamsSchema`,
 * `NotificationsParamsSchema`, `ClientTasksCapabilitySchema`, `ServerTasksCapabilitySchema`).
 * Keeping the list explicit means new public spec types must be added here deliberately, and
 * internals never leak into `SpecTypeName`.
 *
 * `ResourceTemplateSchema` is included; its public type is exported as `ResourceTemplateType`
 * (the bare name collides with the server package's `ResourceTemplate` class), so
 * `SpecTypes['ResourceTemplate']` is structurally equal to `ResourceTemplateType` rather than to
 * a type literally named `ResourceTemplate`.
 */
const SPEC_SCHEMA_KEYS = [
    'AnnotationsSchema',
    'AudioContentSchema',
    'BaseMetadataSchema',
    'BlobResourceContentsSchema',
    'BooleanSchemaSchema',
    'CallToolRequestSchema',
    'CallToolRequestParamsSchema',
    'CallToolResultSchema',
    'CancelledNotificationSchema',
    'CancelledNotificationParamsSchema',
    'CancelTaskRequestSchema',
    'CancelTaskResultSchema',
    'ClientCapabilitiesSchema',
    'ClientNotificationSchema',
    'ClientRequestSchema',
    'ClientResultSchema',
    'CompatibilityCallToolResultSchema',
    'CompleteRequestSchema',
    'CompleteRequestParamsSchema',
    'CompleteResultSchema',
    'ContentBlockSchema',
    'CreateMessageRequestSchema',
    'CreateMessageRequestParamsSchema',
    'CreateMessageResultSchema',
    'CreateMessageResultWithToolsSchema',
    'CreateTaskResultSchema',
    'CursorSchema',
    'ElicitationCompleteNotificationSchema',
    'ElicitationCompleteNotificationParamsSchema',
    'ElicitRequestSchema',
    'ElicitRequestFormParamsSchema',
    'ElicitRequestParamsSchema',
    'ElicitRequestURLParamsSchema',
    'ElicitResultSchema',
    'EmbeddedResourceSchema',
    'EmptyResultSchema',
    'EnumSchemaSchema',
    'GetPromptRequestSchema',
    'GetPromptRequestParamsSchema',
    'GetPromptResultSchema',
    'GetTaskPayloadRequestSchema',
    'GetTaskPayloadResultSchema',
    'GetTaskRequestSchema',
    'GetTaskResultSchema',
    'IconSchema',
    'IconsSchema',
    'ImageContentSchema',
    'ImplementationSchema',
    'InitializedNotificationSchema',
    'InitializeRequestSchema',
    'InitializeRequestParamsSchema',
    'InitializeResultSchema',
    'JSONArraySchema',
    'JSONObjectSchema',
    'JSONRPCErrorResponseSchema',
    'JSONRPCMessageSchema',
    'JSONRPCNotificationSchema',
    'JSONRPCRequestSchema',
    'JSONRPCResponseSchema',
    'JSONRPCResultResponseSchema',
    'JSONValueSchema',
    'LegacyTitledEnumSchemaSchema',
    'ListPromptsRequestSchema',
    'ListPromptsResultSchema',
    'ListResourcesRequestSchema',
    'ListResourcesResultSchema',
    'ListResourceTemplatesRequestSchema',
    'ListResourceTemplatesResultSchema',
    'ListRootsRequestSchema',
    'ListRootsResultSchema',
    'ListTasksRequestSchema',
    'ListTasksResultSchema',
    'ListToolsRequestSchema',
    'ListToolsResultSchema',
    'LoggingLevelSchema',
    'LoggingMessageNotificationSchema',
    'LoggingMessageNotificationParamsSchema',
    'ModelHintSchema',
    'ModelPreferencesSchema',
    'MultiSelectEnumSchemaSchema',
    'NotificationSchema',
    'NumberSchemaSchema',
    'PaginatedRequestSchema',
    'PaginatedRequestParamsSchema',
    'PaginatedResultSchema',
    'PingRequestSchema',
    'PrimitiveSchemaDefinitionSchema',
    'ProgressSchema',
    'ProgressNotificationSchema',
    'ProgressNotificationParamsSchema',
    'ProgressTokenSchema',
    'PromptSchema',
    'PromptArgumentSchema',
    'PromptListChangedNotificationSchema',
    'PromptMessageSchema',
    'PromptReferenceSchema',
    'ReadResourceRequestSchema',
    'ReadResourceRequestParamsSchema',
    'ReadResourceResultSchema',
    'RelatedTaskMetadataSchema',
    'RequestSchema',
    'RequestIdSchema',
    'RequestMetaSchema',
    'ResourceSchema',
    'ResourceContentsSchema',
    'ResourceLinkSchema',
    'ResourceListChangedNotificationSchema',
    'ResourceRequestParamsSchema',
    'ResourceTemplateSchema',
    'ResourceTemplateReferenceSchema',
    'ResourceUpdatedNotificationSchema',
    'ResourceUpdatedNotificationParamsSchema',
    'ResultSchema',
    'RoleSchema',
    'RootSchema',
    'RootsListChangedNotificationSchema',
    'SamplingContentSchema',
    'SamplingMessageSchema',
    'SamplingMessageContentBlockSchema',
    'ServerCapabilitiesSchema',
    'ServerNotificationSchema',
    'ServerRequestSchema',
    'ServerResultSchema',
    'SetLevelRequestSchema',
    'SetLevelRequestParamsSchema',
    'SingleSelectEnumSchemaSchema',
    'StringSchemaSchema',
    'SubscribeRequestSchema',
    'SubscribeRequestParamsSchema',
    'TaskSchema',
    'TaskAugmentedRequestParamsSchema',
    'TaskCreationParamsSchema',
    'TaskMetadataSchema',
    'TaskStatusSchema',
    'TaskStatusNotificationSchema',
    'TaskStatusNotificationParamsSchema',
    'TextContentSchema',
    'TextResourceContentsSchema',
    'TitledMultiSelectEnumSchemaSchema',
    'TitledSingleSelectEnumSchemaSchema',
    'ToolSchema',
    'ToolAnnotationsSchema',
    'ToolChoiceSchema',
    'ToolExecutionSchema',
    'ToolListChangedNotificationSchema',
    'ToolResultContentSchema',
    'ToolUseContentSchema',
    'UnsubscribeRequestSchema',
    'UnsubscribeRequestParamsSchema',
    'UntitledMultiSelectEnumSchemaSchema',
    'UntitledSingleSelectEnumSchemaSchema'
] as const satisfies readonly (keyof typeof schemas)[];

const authSchemas = {
    OAuthClientInformationFullSchema,
    OAuthClientInformationSchema,
    OAuthClientMetadataSchema,
    OAuthClientRegistrationErrorSchema,
    OAuthErrorResponseSchema,
    OAuthMetadataSchema,
    OAuthProtectedResourceMetadataSchema,
    OAuthTokenRevocationRequestSchema,
    OAuthTokensSchema,
    OpenIdProviderDiscoveryMetadataSchema,
    OpenIdProviderMetadataSchema
} as const;

type ProtocolSchemaKey = (typeof SPEC_SCHEMA_KEYS)[number];
type AuthSchemaKey = keyof typeof authSchemas;
type SchemaKey = ProtocolSchemaKey | AuthSchemaKey;

type SchemaFor<K extends SchemaKey> = K extends ProtocolSchemaKey
    ? (typeof schemas)[K]
    : K extends AuthSchemaKey
      ? (typeof authSchemas)[K]
      : never;

type StripSchemaSuffix<K> = K extends `${infer N}Schema` ? N : never;

/**
 * Union of every named type in the SDK's protocol and OAuth schemas (e.g. `'CallToolResult'`,
 * `'ContentBlock'`, `'Tool'`, `'OAuthTokens'`). Derived from the internal Zod schemas, so it stays
 * in sync with the spec.
 */
export type SpecTypeName = StripSchemaSuffix<SchemaKey>;

/**
 * Maps each {@linkcode SpecTypeName} to its TypeScript type.
 *
 * `SpecTypes['CallToolResult']` is equivalent to importing the `CallToolResult` type directly.
 */
export type SpecTypes = {
    [K in SchemaKey as StripSchemaSuffix<K>]: SchemaFor<K> extends z.ZodType ? z.output<SchemaFor<K>> : never;
};

/**
 * Input shape for each {@linkcode SpecTypeName}. For most types this equals {@linkcode SpecTypes},
 * but a few schemas apply defaults/preprocessing, so the accepted input may be looser than the
 * resulting output type.
 */
type SpecTypeInputs = {
    [K in SchemaKey as StripSchemaSuffix<K>]: SchemaFor<K> extends z.ZodType ? z.input<SchemaFor<K>> : never;
};

// Populated for every SpecTypeName by the loops below; the cast lets `allSchemas[name]` be
// non-undefined under `noUncheckedIndexedAccess` when `name` is a SpecTypeName.
const allSchemas = {} as Record<SpecTypeName, z.ZodType>;
for (const key of SPEC_SCHEMA_KEYS) {
    // eslint-disable-next-line import/namespace -- key is constrained to keyof typeof schemas via the satisfies clause above
    allSchemas[key.slice(0, -'Schema'.length) as SpecTypeName] = schemas[key];
}
for (const [key, schema] of Object.entries(authSchemas)) {
    allSchemas[key.slice(0, -'Schema'.length) as SpecTypeName] = schema;
}

/**
 * Returns the runtime validator for the named MCP spec type.
 *
 * Use this when you need to validate a spec-defined shape at a boundary the SDK does not own, for
 * example an extension's custom-method payload that embeds a `CallToolResult`, or a value read from
 * storage that should be a `Tool`.
 *
 * The returned validator implements the Standard Schema interface, so it composes with any
 * Standard-Schema-aware library. For a simple boolean check, use {@linkcode isSpecType} instead.
 *
 * @example
 * ```ts source="./specTypeSchema.examples.ts#specTypeSchema_basicUsage"
 * const result = await specTypeSchema('CallToolResult')['~standard'].validate(untrusted);
 * if (result.issues === undefined) {
 *     // result.value is CallToolResult
 * }
 * ```
 */
export function specTypeSchema<K extends SpecTypeName>(name: K): StandardSchemaV1<SpecTypeInputs[K], SpecTypes[K]>;
export function specTypeSchema(name: SpecTypeName): StandardSchemaV1 {
    return allSchemas[name];
}

/**
 * Type predicate for the named MCP spec type.
 *
 * Returns `true` if the value satisfies the schema's input type (`z.input<>`, before defaults and
 * transforms are applied), and narrows to that input type. For schemas with `.default()` or
 * `.preprocess()`, this may accept values that do not structurally match the named output type;
 * for example `isSpecType('CallToolResult', {})` is `true` because `content` has a default. Use
 * `specTypeSchema(name)['~standard'].validate(value)` when you need the validated output value.
 *
 * @example
 * ```ts source="./specTypeSchema.examples.ts#isSpecType_basicUsage"
 * if (isSpecType('ContentBlock', value)) {
 *     // value is ContentBlock
 * }
 *
 * const blocks = mixed.filter(v => isSpecType('ContentBlock', v));
 * ```
 */
export function isSpecType<K extends SpecTypeName>(name: K, value: unknown): value is SpecTypeInputs[K];
export function isSpecType(name: SpecTypeName, value: unknown): boolean {
    return allSchemas[name].safeParse(value).success;
}
