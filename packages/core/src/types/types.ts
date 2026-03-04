/**
 * MCP SDK type definitions.
 *
 * The bulk of the Zod schemas are auto-generated from the protocol spec
 * (`spec.types.ts`) by `scripts/generate-schemas.ts` and live in
 * `./generated/sdk.schemas.ts`. This file re-exports those schemas and layers
 * on top:
 *
 *  - Protocol version constants (hand-maintained, NOT from spec draft)
 *  - SDK-only schemas (`ProgressSchema`, `SamplingContentSchema`, etc.)
 *  - Schema overrides where SDK behavior intentionally diverges from spec
 *    (`CreateMessageResultSchema` uses a single content block for
 *    backwards-compat; `ElicitResultSchema` coerces `null` content)
 *  - Type guards, assertion helpers, error classes
 *  - Inferred TypeScript types for every schema
 *  - Runtime method→schema lookup tables used by `protocol.ts`
 *
 * If you need to add or change a *spec* type, edit `spec.types.ts` and run
 * `pnpm generate:schemas`. If you need SDK-specific behavior, add it here.
 */

import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Generated schema imports
// ---------------------------------------------------------------------------
// These schemas are generated from spec.types.ts. We import them so they can
// be referenced in `typeof` expressions for type inference, in override
// definitions, and in the runtime schema lookup tables below.
//
// A handful of spec schemas are deliberately NOT imported because the SDK
// overrides them locally:
//  - JSONRPC{Request,Notification,ResultResponse,ErrorResponse,Message}Schema
//    (key-ordering fix — see "JSON-RPC wire schemas" below)
//  - CreateMessageResultSchema, ElicitResultSchema, ClientResultSchema,
//    ServerResultSchema (SDK-specific behavior)
import type {
    AnnotationsSchema,
    BaseMetadataSchema,
    BlobResourceContentsSchema,
    BooleanSchemaSchema,
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CancelledNotificationParamsSchema,
    CancelledNotificationSchema,
    CancelTaskRequestSchema,
    ClientCapabilitiesSchema,
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    ContentBlockSchema,
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    CursorSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestFormParamsSchema,
    ElicitRequestParamsSchema,
    ElicitRequestSchema,
    ElicitRequestURLParamsSchema,
    EmbeddedResourceSchema,
    EnumSchemaSchema,
    GetPromptRequestParamsSchema,
    GetPromptRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    GetTaskRequestSchema,
    IconSchema,
    IconsSchema,
    ImplementationSchema,
    InitializeRequestParamsSchema,
    LegacyTitledEnumSchemaSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListRootsRequestSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    LoggingLevelSchema,
    LoggingMessageNotificationParamsSchema,
    LoggingMessageNotificationSchema,
    ModelHintSchema,
    ModelPreferencesSchema,
    MultiSelectEnumSchemaSchema,
    NumberSchemaSchema,
    PaginatedRequestParamsSchema,
    PaginatedRequestSchema,
    PaginatedResultSchema,
    PingRequestSchema,
    PrimitiveSchemaDefinitionSchema,
    ProgressNotificationParamsSchema,
    ProgressNotificationSchema,
    PromptArgumentSchema,
    PromptListChangedNotificationSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    PromptSchema,
    ReadResourceRequestParamsSchema,
    ReadResourceRequestSchema,
    ResourceContentsSchema,
    ResourceLinkSchema,
    ResourceListChangedNotificationSchema,
    ResourceRequestParamsSchema,
    ResourceSchema,
    ResourceTemplateReferenceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationParamsSchema,
    ResourceUpdatedNotificationSchema,
    RootSchema,
    RootsListChangedNotificationSchema,
    SamplingMessageSchema,
    ServerCapabilitiesSchema,
    SetLevelRequestParamsSchema,
    SetLevelRequestSchema,
    SingleSelectEnumSchemaSchema,
    StringSchemaSchema,
    SubscribeRequestParamsSchema,
    SubscribeRequestSchema,
    TaskMetadataSchema,
    TaskSchema,
    TaskStatusNotificationParamsSchema,
    TaskStatusNotificationSchema,
    TaskStatusSchema,
    TextResourceContentsSchema,
    TitledMultiSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    ToolAnnotationsSchema,
    ToolChoiceSchema,
    ToolExecutionSchema,
    ToolListChangedNotificationSchema,
    ToolResultContentSchema,
    ToolSchema,
    ToolUseContentSchema,
    UnsubscribeRequestParamsSchema,
    UnsubscribeRequestSchema,
    UntitledMultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema
} from './generated/sdk.schemas.js';
import {
    AudioContentSchema,
    CallToolResultSchema,
    CancelTaskResultSchema,
    ClientNotificationSchema,
    ClientRequestSchema,
    CompleteResultSchema,
    CreateTaskResultSchema,
    EmptyResultSchema,
    GetPromptResultSchema,
    GetTaskResultSchema,
    ImageContentSchema,
    InitializedNotificationSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListRootsResultSchema,
    ListTasksResultSchema,
    ListToolsResultSchema,
    NotificationSchema,
    ProgressTokenSchema,
    ReadResourceResultSchema,
    RelatedTaskMetadataSchema,
    RequestIdSchema,
    RequestSchema,
    ResultSchema,
    RoleSchema,
    SamplingMessageContentBlockSchema,
    ServerNotificationSchema,
    ServerRequestSchema,
    TaskAugmentedRequestParamsSchema,
    TextContentSchema
} from './generated/sdk.schemas.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
// Re-export all generated schemas that match SDK semantics unchanged. This
// block is intentionally explicit (rather than `export *`) so that the four
// overridden schemas cannot leak through.
export {
    AnnotationsSchema,
    AudioContentSchema,
    BaseMetadataSchema,
    BlobResourceContentsSchema,
    BooleanSchemaSchema,
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationParamsSchema,
    CancelledNotificationSchema,
    CancelTaskRequestSchema,
    CancelTaskResultSchema,
    ClientCapabilitiesSchema,
    ClientNotificationSchema,
    ClientRequestSchema,
    ClientTasksCapabilitySchema,
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    ContentBlockSchema,
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    CreateTaskResultSchema,
    CursorSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestFormParamsSchema,
    ElicitRequestParamsSchema,
    ElicitRequestSchema,
    ElicitRequestURLParamsSchema,
    EmbeddedResourceSchema,
    EmptyResultSchema,
    EnumSchemaSchema,
    ErrorSchema,
    GetPromptRequestParamsSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    IconSchema,
    IconsSchema,
    ImageContentSchema,
    ImplementationSchema,
    InitializedNotificationSchema,
    InitializeRequestParamsSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    LegacyTitledEnumSchemaSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListTasksRequestSchema,
    ListTasksResultSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    LoggingLevelSchema,
    LoggingMessageNotificationParamsSchema,
    LoggingMessageNotificationSchema,
    ModelHintSchema,
    ModelPreferencesSchema,
    MultiSelectEnumSchemaSchema,
    NotificationParamsSchema,
    NotificationSchema,
    NumberSchemaSchema,
    PaginatedRequestParamsSchema,
    PaginatedRequestSchema,
    PaginatedResultSchema,
    PingRequestSchema,
    PrimitiveSchemaDefinitionSchema,
    ProgressNotificationParamsSchema,
    ProgressNotificationSchema,
    ProgressTokenSchema,
    PromptArgumentSchema,
    PromptListChangedNotificationSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    PromptSchema,
    ReadResourceRequestParamsSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    RelatedTaskMetadataSchema,
    RequestIdSchema,
    RequestParamsSchema,
    RequestSchema,
    ResourceContentsSchema,
    ResourceLinkSchema,
    ResourceListChangedNotificationSchema,
    ResourceRequestParamsSchema,
    ResourceSchema,
    ResourceTemplateReferenceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationParamsSchema,
    ResourceUpdatedNotificationSchema,
    ResultSchema,
    RoleSchema,
    RootSchema,
    RootsListChangedNotificationSchema,
    SamplingMessageContentBlockSchema,
    SamplingMessageSchema,
    ServerCapabilitiesSchema,
    ServerNotificationSchema,
    ServerRequestSchema,
    ServerTasksCapabilitySchema,
    SetLevelRequestParamsSchema,
    SetLevelRequestSchema,
    SingleSelectEnumSchemaSchema,
    StringSchemaSchema,
    SubscribeRequestParamsSchema,
    SubscribeRequestSchema,
    TaskAugmentedRequestParamsSchema,
    TaskMetadataSchema,
    TaskSchema,
    TaskStatusNotificationParamsSchema,
    TaskStatusNotificationSchema,
    TaskStatusSchema,
    TextContentSchema,
    TextResourceContentsSchema,
    TitledMultiSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    ToolAnnotationsSchema,
    ToolChoiceSchema,
    ToolExecutionSchema,
    ToolListChangedNotificationSchema,
    ToolResultContentSchema,
    ToolSchema,
    ToolUseContentSchema,
    UnsubscribeRequestParamsSchema,
    UnsubscribeRequestSchema,
    UntitledMultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    URLElicitationRequiredErrorSchema
} from './generated/sdk.schemas.js';

// Re-export the discriminated-union marker types introduced by the generator.
export type { McpNotification, McpRequest, McpResult } from './generated/sdk.types.js';

// ===========================================================================
// Protocol constants
// ===========================================================================
// These are hand-maintained. The generator would otherwise pick up whatever
// draft version is in spec.types.ts, which is not what the SDK should
// advertise at runtime.

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/** `_meta` key under which task-related metadata is stored on request params. */
export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

export const JSONRPC_VERSION = '2.0';

// ===========================================================================
// JSON-RPC wire schemas (SDK overrides)
// ===========================================================================
// The generator emits these as `Base.extend({ jsonrpc })`, which Zod serializes
// with `jsonrpc` *last* in parse output. Transports (see `deserializeMessage`
// in `shared/stdio.ts`) round-trip every message through these schemas, so we
// preserve the historical `jsonrpc`-first ordering by spreading `.shape`
// explicitly.

/** A request that expects a response. */
export const JSONRPCRequestSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema,
        ...RequestSchema.shape
    })
    .strict();

/** A notification which does not expect a response. */
export const JSONRPCNotificationSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        ...NotificationSchema.shape
    })
    .strict();

/** A successful (non-error) response to a request. */
export const JSONRPCResultResponseSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema,
        result: ResultSchema
    })
    .strict();

/** A response to a request that indicates an error occurred. */
export const JSONRPCErrorResponseSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema.optional(),
        error: z.object({
            /** The error type that occurred. */
            code: z.number().int(),
            /** A short description of the error. The message SHOULD be limited to a concise single sentence. */
            message: z.string(),
            /** Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.). */
            data: z.unknown().optional()
        })
    })
    .strict();

/**
 * Refers to any valid JSON-RPC object that can be decoded off the wire, or
 * encoded to be sent.
 */
export const JSONRPCMessageSchema = z.union([
    JSONRPCRequestSchema,
    JSONRPCNotificationSchema,
    JSONRPCResultResponseSchema,
    JSONRPCErrorResponseSchema
]);

// ===========================================================================
// Auth
// ===========================================================================

/**
 * Authentication context for an MCP connection.
 *
 * Transports populate this when a request is authenticated (typically via
 * OAuth) and pass it through to request handlers via {@link MessageExtraInfo}.
 */
export interface AuthInfo {
    /** The raw bearer token. */
    token: string;
    /** OAuth client ID. */
    clientId: string;
    /** Granted scopes. */
    scopes: string[];
    /** Unix timestamp (seconds) when the token expires, if known. */
    expiresAt?: number;
    /** The resource the token is bound to (RFC 8707). */
    resource?: URL;
    /** Transport-specific extras. */
    extra?: Record<string, unknown>;
}

// ===========================================================================
// Utility types
// ===========================================================================

/**
 * Forces TypeScript to fully expand a mapped/intersection type in tooltips
 * and error messages instead of showing the unevaluated type expression.
 */
type ExpandRecursively<T> = T extends object ? (T extends infer O ? { [K in keyof O]: ExpandRecursively<O[K]> } : never) : T;

type Primitive = string | number | boolean | bigint | null | undefined;

/**
 * Recursively flattens a type so Zod's branded/intersected output becomes a
 * plain structural type. Wrapped around `z.infer` below.
 */
type Flatten<T> = T extends Primitive
    ? T
    : T extends Array<infer U>
      ? Array<Flatten<U>>
      : T extends Set<infer U>
        ? Set<Flatten<U>>
        : T extends Map<infer K, infer V>
          ? Map<Flatten<K>, Flatten<V>>
          : T extends object
            ? { [K in keyof T]: Flatten<T[K]> }
            : T;

type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;

// ===========================================================================
// Internal base-params schemas
// ===========================================================================
// The generated `RequestParamsSchema` / `NotificationParamsSchema` are spec-
// accurate but do not include the SDK's `RELATED_TASK_META_KEY` in `_meta`.
// We keep small local schemas purely to drive the `RequestMeta`,
// `RequestParams`, and `NotificationParams` inferred types, which SDK
// consumers rely on having the task key statically typed.

const RequestMetaSchema = z.looseObject({
    progressToken: ProgressTokenSchema.optional(),
    [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});

/**
 * Shared base for both request and notification params. Request and
 * notification `_meta` shapes are identical at the SDK layer, so one schema
 * backs both {@link RequestParams} and {@link NotificationParams}.
 */
const BaseParamsSchema = z.object({
    _meta: RequestMetaSchema.optional()
});

// ===========================================================================
// SDK-only schemas (not in spec)
// ===========================================================================

/**
 * Parameters controlling how a long-running request is turned into a task.
 * Passed by SDK callers alongside request params; not sent on the wire.
 */
export const TaskCreationParamsSchema = z.looseObject({
    ttl: z.union([z.number(), z.null()]).optional(),
    pollInterval: z.number().optional()
});

/**
 * Union of success and error JSON-RPC responses. The spec treats these as
 * distinct message kinds; the SDK also exposes them as a single union for
 * transports that want to pattern-match on "any response".
 */
export const JSONRPCResponseSchema = z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);

/**
 * Shape of a progress update, shared between `ProgressNotification` params
 * and the SDK's `onprogress` callback signature.
 */
export const ProgressSchema = z.object({
    progress: z.number(),
    total: z.optional(z.number()),
    message: z.optional(z.string())
});

/**
 * Backwards-compat discriminated union over text/image/audio blocks.
 * Used by the legacy single-block {@link CreateMessageResultSchema} below.
 */
export const SamplingContentSchema = z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema, AudioContentSchema]);

/**
 * Standalone schema for the params of `notifications/elicitation/complete`.
 * The generated {@link ElicitationCompleteNotificationSchema} inlines its
 * params; we expose this separately so SDK code can validate just the params.
 */
export const ElicitationCompleteNotificationParamsSchema = BaseParamsSchema.extend({
    elicitationId: z.string()
});

/**
 * Accepts the legacy `toolResult`-keyed shape from very old MCP servers in
 * addition to the modern {@link CallToolResultSchema}.
 */
export const CompatibilityCallToolResultSchema = CallToolResultSchema.or(
    ResultSchema.extend({
        toolResult: z.unknown()
    })
);

/**
 * Base Zod schema for list-changed subscription options (the non-callback
 * parts). Used internally by the client to validate and default the numeric
 * options; the callback lives in {@link ListChangedOptions} because functions
 * don't belong in Zod.
 */
export const ListChangedOptionsBaseSchema = z.object({
    autoRefresh: z.boolean().default(true),
    debounceMs: z.number().int().nonnegative().default(300)
});

// ===========================================================================
// Schema overrides (SDK intentionally diverges from spec)
// ===========================================================================

/**
 * SDK override: the spec defines `content` as an array of blocks, but the
 * SDK's primary `createMessage` API predates that change and returns a single
 * block. Callers who need multi-block / tool-use results should use
 * {@link CreateMessageResultWithToolsSchema} instead.
 */
export const CreateMessageResultSchema = ResultSchema.extend({
    model: z.string(),
    stopReason: z.optional(z.enum(['endTurn', 'stopSequence', 'maxTokens']).or(z.string())),
    role: RoleSchema,
    content: SamplingContentSchema
});

/**
 * Multi-block sampling result that can also carry tool-use blocks.
 * Returned by the tool-enabled `createMessage` overload.
 */
export const CreateMessageResultWithToolsSchema = ResultSchema.extend({
    model: z.string(),
    stopReason: z.optional(z.enum(['endTurn', 'stopSequence', 'maxTokens', 'toolUse']).or(z.string())),
    role: RoleSchema,
    content: z.union([SamplingMessageContentBlockSchema, z.array(SamplingMessageContentBlockSchema)])
});

/**
 * SDK override: coerces `content: null` → `undefined` before validation.
 * Some early clients sent `null` here; the spec says the field is optional
 * (absent), not nullable, so we normalise rather than fail.
 */
export const ElicitResultSchema = ResultSchema.extend({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: z.preprocess(
        val => (val === null ? undefined : val),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
    )
});

/**
 * SDK override: adds {@link CreateMessageResultWithToolsSchema} (SDK-only)
 * and uses the SDK's overridden result schemas above.
 */
export const ClientResultSchema = z.union([
    EmptyResultSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    ListRootsResultSchema,
    GetTaskResultSchema,
    ListTasksResultSchema,
    CreateTaskResultSchema
]);

/**
 * SDK override: includes {@link CreateTaskResultSchema} and the SDK's
 * overridden result schemas.
 */
export const ServerResultSchema = z.union([
    EmptyResultSchema,
    InitializeResultSchema,
    CompleteResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ReadResourceResultSchema,
    CallToolResultSchema,
    ListToolsResultSchema,
    GetTaskResultSchema,
    ListTasksResultSchema,
    CreateTaskResultSchema
]);

// ===========================================================================
// Error codes & classes
// ===========================================================================

export enum ProtocolErrorCode {
    ParseError = -32_700,
    InvalidRequest = -32_600,
    MethodNotFound = -32_601,
    InvalidParams = -32_602,
    InternalError = -32_603,
    UrlElicitationRequired = -32_042
}

/**
 * A JSON-RPC level error. Thrown on the client when the server returns an
 * error response, and on the server to signal an error response should be
 * sent. `code` is a {@link ProtocolErrorCode} or an application-defined code.
 */
export class ProtocolError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(`MCP error ${code}: ${message}`);
        this.name = 'ProtocolError';
    }

    /**
     * Constructs a `ProtocolError` (or the more specific
     * {@link UrlElicitationRequiredError} when the code/data match) from the
     * fields of a JSON-RPC error response.
     */
    static fromError(code: number, message: string, data?: unknown): ProtocolError {
        if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
            const errorData = data as { elicitations?: unknown[] };
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
            }
        }
        return new ProtocolError(code, message, data);
    }
}

/**
 * Thrown when a request requires the user to complete an out-of-band URL
 * elicitation before it can succeed.
 */
export class UrlElicitationRequiredError extends ProtocolError {
    constructor(elicitations: ElicitRequestURLParams[], message: string = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ProtocolErrorCode.UrlElicitationRequired, message, { elicitations: elicitations });
    }

    get elicitations(): ElicitRequestURLParams[] {
        return (this.data as { elicitations: ElicitRequestURLParams[] })?.elicitations ?? [];
    }
}

// ===========================================================================
// Type guards
// ===========================================================================

export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest => JSONRPCRequestSchema.safeParse(value).success;

export const isJSONRPCNotification = (value: unknown): value is JSONRPCNotification => JSONRPCNotificationSchema.safeParse(value).success;

export const isJSONRPCResultResponse = (value: unknown): value is JSONRPCResultResponse =>
    JSONRPCResultResponseSchema.safeParse(value).success;

export const isJSONRPCErrorResponse = (value: unknown): value is JSONRPCErrorResponse =>
    JSONRPCErrorResponseSchema.safeParse(value).success;

export const isInitializeRequest = (value: unknown): value is InitializeRequest => InitializeRequestSchema.safeParse(value).success;

export const isInitializedNotification = (value: unknown): value is InitializedNotification =>
    InitializedNotificationSchema.safeParse(value).success;

export const isTaskAugmentedRequestParams = (value: unknown): value is TaskAugmentedRequestParams =>
    TaskAugmentedRequestParamsSchema.safeParse(value).success;

// ===========================================================================
// Assertion helpers
// ===========================================================================

export function assertCompleteRequestPrompt(request: CompleteRequest): asserts request is CompleteRequestPrompt {
    if (request.params.ref.type !== 'ref/prompt') {
        throw new TypeError(`Expected CompleteRequestPrompt, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestPrompt);
}

export function assertCompleteRequestResourceTemplate(request: CompleteRequest): asserts request is CompleteRequestResourceTemplate {
    if (request.params.ref.type !== 'ref/resource') {
        throw new TypeError(`Expected CompleteRequestResourceTemplate, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestResourceTemplate);
}

// ===========================================================================
// SDK-only types (no backing schema)
// ===========================================================================

/** Callback invoked when a server-side list changes. */
export type ListChangedCallback<T> = (error: Error | null, items: T[] | null) => void;

/**
 * Options for subscribing to `list_changed` notifications for a given
 * primitive kind.
 *
 * @typeParam T - The item type (`Tool`, `Prompt`, or `Resource`).
 */
export type ListChangedOptions<T> = {
    /**
     * When `true`, the SDK re-fetches the list automatically and passes the
     * new items to `onChanged`. When `false`, `onChanged` receives `null`
     * items and the caller is expected to refresh manually.
     * @default true
     */
    autoRefresh?: boolean;
    /**
     * Debounce window in milliseconds. Multiple notifications within the
     * window collapse into a single refresh. `0` disables debouncing.
     * @default 300
     */
    debounceMs?: number;
    /** Invoked when the list changes (see `autoRefresh` for semantics). */
    onChanged: ListChangedCallback<T>;
};

/**
 * Per-primitive list-changed handler configuration. Handlers are only
 * wired up if the server advertises the corresponding `listChanged`
 * capability.
 */
export type ListChangedHandlers = {
    tools?: ListChangedOptions<Tool>;
    prompts?: ListChangedOptions<Prompt>;
    resources?: ListChangedOptions<Resource>;
};

/**
 * {@link CreateMessageRequestParams} without `tools`/`toolChoice`, for the
 * backwards-compatible (single-block result) `createMessage` overload.
 */
export type CreateMessageRequestParamsBase = Omit<CreateMessageRequestParams, 'tools' | 'toolChoice'>;

/**
 * {@link CreateMessageRequestParams} with `tools` made required, for the
 * tool-enabled `createMessage` overload.
 */
export interface CreateMessageRequestParamsWithTools extends CreateMessageRequestParams {
    tools: Tool[];
}

// ===========================================================================
// Transport-level types
// ===========================================================================

/**
 * Transport-provided metadata about the underlying HTTP (or other) request
 * that delivered an MCP message.
 */
export interface RequestInfo {
    headers: Headers;
}

/**
 * Side-channel information passed to request/notification handlers alongside
 * the parsed MCP message.
 */
export interface MessageExtraInfo {
    requestInfo?: RequestInfo;
    authInfo?: AuthInfo;
    /** HTTP transports expose this so handlers can terminate the per-request SSE stream early. */
    closeSSEStream?: () => void;
    /** HTTP transports expose this so handlers can terminate the standalone (server-initiated) SSE stream. */
    closeStandaloneSSEStream?: () => void;
}

// ===========================================================================
// Inferred types
// ===========================================================================

/* JSON-RPC */
export type ProgressToken = Infer<typeof ProgressTokenSchema>;
export type Cursor = Infer<typeof CursorSchema>;
export type Request = Infer<typeof RequestSchema>;
export type TaskAugmentedRequestParams = Infer<typeof TaskAugmentedRequestParamsSchema>;
export type RequestMeta = Infer<typeof RequestMetaSchema>;
export type Notification = Infer<typeof NotificationSchema>;
export type Result = Infer<typeof ResultSchema>;
export type RequestId = Infer<typeof RequestIdSchema>;
export type JSONRPCRequest = Infer<typeof JSONRPCRequestSchema>;
export type JSONRPCNotification = Infer<typeof JSONRPCNotificationSchema>;
export type JSONRPCResponse = Infer<typeof JSONRPCResponseSchema>;
export type JSONRPCErrorResponse = Infer<typeof JSONRPCErrorResponseSchema>;
export type JSONRPCResultResponse = Infer<typeof JSONRPCResultResponseSchema>;
export type JSONRPCMessage = Infer<typeof JSONRPCMessageSchema>;
export type RequestParams = Infer<typeof BaseParamsSchema>;
export type NotificationParams = Infer<typeof BaseParamsSchema>;

/* Empty result */
export type EmptyResult = Infer<typeof EmptyResultSchema>;

/* Cancellation */
export type CancelledNotificationParams = Infer<typeof CancelledNotificationParamsSchema>;
export type CancelledNotification = Infer<typeof CancelledNotificationSchema>;

/* Base metadata */
export type Icon = Infer<typeof IconSchema>;
export type Icons = Infer<typeof IconsSchema>;
export type BaseMetadata = Infer<typeof BaseMetadataSchema>;
export type Annotations = Infer<typeof AnnotationsSchema>;
export type Role = Infer<typeof RoleSchema>;

/* Initialization */
export type Implementation = Infer<typeof ImplementationSchema>;
export type ClientCapabilities = Infer<typeof ClientCapabilitiesSchema>;
export type InitializeRequestParams = Infer<typeof InitializeRequestParamsSchema>;
export type InitializeRequest = Infer<typeof InitializeRequestSchema>;
export type ServerCapabilities = Infer<typeof ServerCapabilitiesSchema>;
export type InitializeResult = Infer<typeof InitializeResultSchema>;
export type InitializedNotification = Infer<typeof InitializedNotificationSchema>;

/* Ping */
export type PingRequest = Infer<typeof PingRequestSchema>;

/* Progress */
export type Progress = Infer<typeof ProgressSchema>;
export type ProgressNotificationParams = Infer<typeof ProgressNotificationParamsSchema>;
export type ProgressNotification = Infer<typeof ProgressNotificationSchema>;

/* Tasks */
export type Task = Infer<typeof TaskSchema>;
export type TaskStatus = Infer<typeof TaskStatusSchema>;
export type TaskCreationParams = Infer<typeof TaskCreationParamsSchema>;
export type TaskMetadata = Infer<typeof TaskMetadataSchema>;
export type RelatedTaskMetadata = Infer<typeof RelatedTaskMetadataSchema>;
export type CreateTaskResult = Infer<typeof CreateTaskResultSchema>;
export type TaskStatusNotificationParams = Infer<typeof TaskStatusNotificationParamsSchema>;
export type TaskStatusNotification = Infer<typeof TaskStatusNotificationSchema>;
export type GetTaskRequest = Infer<typeof GetTaskRequestSchema>;
export type GetTaskResult = Infer<typeof GetTaskResultSchema>;
export type GetTaskPayloadRequest = Infer<typeof GetTaskPayloadRequestSchema>;
export type ListTasksRequest = Infer<typeof ListTasksRequestSchema>;
export type ListTasksResult = Infer<typeof ListTasksResultSchema>;
export type CancelTaskRequest = Infer<typeof CancelTaskRequestSchema>;
export type CancelTaskResult = Infer<typeof CancelTaskResultSchema>;
export type GetTaskPayloadResult = Infer<typeof GetTaskPayloadResultSchema>;

/* Pagination */
export type PaginatedRequestParams = Infer<typeof PaginatedRequestParamsSchema>;
export type PaginatedRequest = Infer<typeof PaginatedRequestSchema>;
export type PaginatedResult = Infer<typeof PaginatedResultSchema>;

/* Resources */
export type ResourceContents = Infer<typeof ResourceContentsSchema>;
export type TextResourceContents = Infer<typeof TextResourceContentsSchema>;
export type BlobResourceContents = Infer<typeof BlobResourceContentsSchema>;
export type Resource = Infer<typeof ResourceSchema>;
// TODO: Overlaps with the exported `ResourceTemplate` class from `@modelcontextprotocol/server`.
export type ResourceTemplateType = Infer<typeof ResourceTemplateSchema>;
export type ListResourcesRequest = Infer<typeof ListResourcesRequestSchema>;
export type ListResourcesResult = Infer<typeof ListResourcesResultSchema>;
export type ListResourceTemplatesRequest = Infer<typeof ListResourceTemplatesRequestSchema>;
export type ListResourceTemplatesResult = Infer<typeof ListResourceTemplatesResultSchema>;
export type ResourceRequestParams = Infer<typeof ResourceRequestParamsSchema>;
export type ReadResourceRequestParams = Infer<typeof ReadResourceRequestParamsSchema>;
export type ReadResourceRequest = Infer<typeof ReadResourceRequestSchema>;
export type ReadResourceResult = Infer<typeof ReadResourceResultSchema>;
export type ResourceListChangedNotification = Infer<typeof ResourceListChangedNotificationSchema>;
export type SubscribeRequestParams = Infer<typeof SubscribeRequestParamsSchema>;
export type SubscribeRequest = Infer<typeof SubscribeRequestSchema>;
export type UnsubscribeRequestParams = Infer<typeof UnsubscribeRequestParamsSchema>;
export type UnsubscribeRequest = Infer<typeof UnsubscribeRequestSchema>;
export type ResourceUpdatedNotificationParams = Infer<typeof ResourceUpdatedNotificationParamsSchema>;
export type ResourceUpdatedNotification = Infer<typeof ResourceUpdatedNotificationSchema>;

/* Prompts */
export type PromptArgument = Infer<typeof PromptArgumentSchema>;
export type Prompt = Infer<typeof PromptSchema>;
export type ListPromptsRequest = Infer<typeof ListPromptsRequestSchema>;
export type ListPromptsResult = Infer<typeof ListPromptsResultSchema>;
export type GetPromptRequestParams = Infer<typeof GetPromptRequestParamsSchema>;
export type GetPromptRequest = Infer<typeof GetPromptRequestSchema>;
export type TextContent = Infer<typeof TextContentSchema>;
export type ImageContent = Infer<typeof ImageContentSchema>;
export type AudioContent = Infer<typeof AudioContentSchema>;
export type ToolUseContent = Infer<typeof ToolUseContentSchema>;
export type ToolResultContent = Infer<typeof ToolResultContentSchema>;
export type EmbeddedResource = Infer<typeof EmbeddedResourceSchema>;
export type ResourceLink = Infer<typeof ResourceLinkSchema>;
export type ContentBlock = Infer<typeof ContentBlockSchema>;
export type PromptMessage = Infer<typeof PromptMessageSchema>;
export type GetPromptResult = Infer<typeof GetPromptResultSchema>;
export type PromptListChangedNotification = Infer<typeof PromptListChangedNotificationSchema>;

/* Tools */
export type ToolAnnotations = Infer<typeof ToolAnnotationsSchema>;
export type ToolExecution = Infer<typeof ToolExecutionSchema>;
export type Tool = Infer<typeof ToolSchema>;
export type ListToolsRequest = Infer<typeof ListToolsRequestSchema>;
export type ListToolsResult = Infer<typeof ListToolsResultSchema>;
export type CallToolRequestParams = Infer<typeof CallToolRequestParamsSchema>;
export type CallToolResult = Infer<typeof CallToolResultSchema>;
export type CompatibilityCallToolResult = Infer<typeof CompatibilityCallToolResultSchema>;
export type CallToolRequest = Infer<typeof CallToolRequestSchema>;
export type ToolListChangedNotification = Infer<typeof ToolListChangedNotificationSchema>;

/* Logging */
export type LoggingLevel = Infer<typeof LoggingLevelSchema>;
export type SetLevelRequestParams = Infer<typeof SetLevelRequestParamsSchema>;
export type SetLevelRequest = Infer<typeof SetLevelRequestSchema>;
export type LoggingMessageNotificationParams = Infer<typeof LoggingMessageNotificationParamsSchema>;
export type LoggingMessageNotification = Infer<typeof LoggingMessageNotificationSchema>;

/* Sampling */
export type ToolChoice = Infer<typeof ToolChoiceSchema>;
export type ModelHint = Infer<typeof ModelHintSchema>;
export type ModelPreferences = Infer<typeof ModelPreferencesSchema>;
export type SamplingContent = Infer<typeof SamplingContentSchema>;
export type SamplingMessageContentBlock = Infer<typeof SamplingMessageContentBlockSchema>;
export type SamplingMessage = Infer<typeof SamplingMessageSchema>;
export type CreateMessageRequestParams = Infer<typeof CreateMessageRequestParamsSchema>;
export type CreateMessageRequest = Infer<typeof CreateMessageRequestSchema>;
export type CreateMessageResult = Infer<typeof CreateMessageResultSchema>;
export type CreateMessageResultWithTools = Infer<typeof CreateMessageResultWithToolsSchema>;

/* Elicitation */
export type BooleanSchema = Infer<typeof BooleanSchemaSchema>;
export type StringSchema = Infer<typeof StringSchemaSchema>;
export type NumberSchema = Infer<typeof NumberSchemaSchema>;
export type EnumSchema = Infer<typeof EnumSchemaSchema>;
export type UntitledSingleSelectEnumSchema = Infer<typeof UntitledSingleSelectEnumSchemaSchema>;
export type TitledSingleSelectEnumSchema = Infer<typeof TitledSingleSelectEnumSchemaSchema>;
export type LegacyTitledEnumSchema = Infer<typeof LegacyTitledEnumSchemaSchema>;
export type UntitledMultiSelectEnumSchema = Infer<typeof UntitledMultiSelectEnumSchemaSchema>;
export type TitledMultiSelectEnumSchema = Infer<typeof TitledMultiSelectEnumSchemaSchema>;
export type SingleSelectEnumSchema = Infer<typeof SingleSelectEnumSchemaSchema>;
export type MultiSelectEnumSchema = Infer<typeof MultiSelectEnumSchemaSchema>;
export type PrimitiveSchemaDefinition = Infer<typeof PrimitiveSchemaDefinitionSchema>;
export type ElicitRequestParams = Infer<typeof ElicitRequestParamsSchema>;
export type ElicitRequestFormParams = Infer<typeof ElicitRequestFormParamsSchema>;
export type ElicitRequestURLParams = Infer<typeof ElicitRequestURLParamsSchema>;
export type ElicitRequest = Infer<typeof ElicitRequestSchema>;
export type ElicitationCompleteNotificationParams = Infer<typeof ElicitationCompleteNotificationParamsSchema>;
export type ElicitationCompleteNotification = Infer<typeof ElicitationCompleteNotificationSchema>;
export type ElicitResult = Infer<typeof ElicitResultSchema>;

/* Autocomplete */
export type ResourceTemplateReference = Infer<typeof ResourceTemplateReferenceSchema>;
export type PromptReference = Infer<typeof PromptReferenceSchema>;
export type CompleteRequestParams = Infer<typeof CompleteRequestParamsSchema>;
export type CompleteRequest = Infer<typeof CompleteRequestSchema>;
export type CompleteRequestResourceTemplate = ExpandRecursively<
    CompleteRequest & { params: CompleteRequestParams & { ref: ResourceTemplateReference } }
>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & { params: CompleteRequestParams & { ref: PromptReference } }>;
export type CompleteResult = Infer<typeof CompleteResultSchema>;

/* Roots */
export type Root = Infer<typeof RootSchema>;
export type ListRootsRequest = Infer<typeof ListRootsRequestSchema>;
export type ListRootsResult = Infer<typeof ListRootsResultSchema>;
export type RootsListChangedNotification = Infer<typeof RootsListChangedNotificationSchema>;

/* Client messages */
export type ClientRequest = Infer<typeof ClientRequestSchema>;
export type ClientNotification = Infer<typeof ClientNotificationSchema>;
export type ClientResult = Infer<typeof ClientResultSchema>;

/* Server messages */
export type ServerRequest = Infer<typeof ServerRequestSchema>;
export type ServerNotification = Infer<typeof ServerNotificationSchema>;
export type ServerResult = Infer<typeof ServerResultSchema>;

// ===========================================================================
// Runtime method → schema lookup
// ===========================================================================
// `protocol.ts` dispatches incoming messages by `method` and needs to look up
// the right schema to parse with. We build these tables once at module load.

type MethodToTypeMap<U> = {
    [T in U as T extends { method: infer M extends string } ? M : never]: T;
};

export type RequestMethod = ClientRequest['method'] | ServerRequest['method'];
export type NotificationMethod = ClientNotification['method'] | ServerNotification['method'];
export type RequestTypeMap = MethodToTypeMap<ClientRequest | ServerRequest>;
export type NotificationTypeMap = MethodToTypeMap<ClientNotification | ServerNotification>;

export type ResultTypeMap = {
    ping: EmptyResult;
    initialize: InitializeResult;
    'completion/complete': CompleteResult;
    'logging/setLevel': EmptyResult;
    'prompts/get': GetPromptResult;
    'prompts/list': ListPromptsResult;
    'resources/list': ListResourcesResult;
    'resources/templates/list': ListResourceTemplatesResult;
    'resources/read': ReadResourceResult;
    'resources/subscribe': EmptyResult;
    'resources/unsubscribe': EmptyResult;
    'tools/call': CallToolResult | CreateTaskResult;
    'tools/list': ListToolsResult;
    'sampling/createMessage': CreateMessageResult | CreateMessageResultWithTools | CreateTaskResult;
    'elicitation/create': ElicitResult | CreateTaskResult;
    'roots/list': ListRootsResult;
    'tasks/get': GetTaskResult;
    'tasks/result': Result;
    'tasks/list': ListTasksResult;
    'tasks/cancel': CancelTaskResult;
};

const resultSchemas: Record<string, z.core.$ZodType> = {
    ping: EmptyResultSchema,
    initialize: InitializeResultSchema,
    'completion/complete': CompleteResultSchema,
    'logging/setLevel': EmptyResultSchema,
    'prompts/get': GetPromptResultSchema,
    'prompts/list': ListPromptsResultSchema,
    'resources/list': ListResourcesResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema,
    'resources/read': ReadResourceResultSchema,
    'resources/subscribe': EmptyResultSchema,
    'resources/unsubscribe': EmptyResultSchema,
    'tools/call': z.union([CallToolResultSchema, CreateTaskResultSchema]),
    'tools/list': ListToolsResultSchema,
    'sampling/createMessage': z.union([CreateMessageResultWithToolsSchema, CreateTaskResultSchema]),
    'elicitation/create': z.union([ElicitResultSchema, CreateTaskResultSchema]),
    'roots/list': ListRootsResultSchema,
    'tasks/get': GetTaskResultSchema,
    'tasks/result': ResultSchema,
    'tasks/list': ListTasksResultSchema,
    'tasks/cancel': CancelTaskResultSchema
};

/** Returns the result schema for a given request method. */
export function getResultSchema<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]> {
    return resultSchemas[method] as unknown as z.ZodType<ResultTypeMap[M]>;
}

type RequestSchemaType = (typeof ClientRequestSchema.options)[number] | (typeof ServerRequestSchema.options)[number];
type NotificationSchemaType = (typeof ClientNotificationSchema.options)[number] | (typeof ServerNotificationSchema.options)[number];

function buildSchemaMap<T extends { shape: { method: { value: string } } }>(schemas: readonly T[]): Record<string, T> {
    const map: Record<string, T> = {};
    for (const schema of schemas) {
        const method = schema.shape.method.value;
        map[method] = schema;
    }
    return map;
}

const requestSchemas = buildSchemaMap([...ClientRequestSchema.options, ...ServerRequestSchema.options] as const) as Record<
    RequestMethod,
    RequestSchemaType
>;

const notificationSchemas = buildSchemaMap([...ClientNotificationSchema.options, ...ServerNotificationSchema.options] as const) as Record<
    NotificationMethod,
    NotificationSchemaType
>;

/** Returns the request schema for a given method. */
export function getRequestSchema<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]> {
    return requestSchemas[method] as unknown as z.ZodType<RequestTypeMap[M]>;
}

/** Returns the notification schema for a given method. */
export function getNotificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]> {
    return notificationSchemas[method] as unknown as z.ZodType<NotificationTypeMap[M]>;
}
