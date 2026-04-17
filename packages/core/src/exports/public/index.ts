/**
 * Curated public API exports for @modelcontextprotocol/core.
 *
 * This module defines the stable, public-facing API surface. Client and server
 * packages re-export from here so that end users only see supported symbols.
 *
 * Internal utilities (stdio parsing, schema helpers, etc.) remain available via
 * the internal barrel (@modelcontextprotocol/core) for use by client/server
 * packages.
 */

// Auth error classes
export { OAuthError, OAuthErrorCode } from '../../auth/errors.js';

// SDK error types (local errors that never cross the wire)
export { SdkError, SdkErrorCode } from '../../errors/sdkErrors.js';

// Auth TypeScript types (NOT Zod schemas like OAuthMetadataSchema)
export type {
    AuthorizationServerMetadata,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientRegistrationError,
    OAuthErrorResponse,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    OAuthTokenRevocationRequest,
    OAuthTokens,
    OpenIdProviderDiscoveryMetadata,
    OpenIdProviderMetadata
} from '../../shared/auth.js';

// Auth utilities
export { checkResourceAllowed, resourceUrlFromServerUrl } from '../../shared/authUtils.js';

// Metadata utilities
export { getDisplayName } from '../../shared/metadataUtils.js';

// Protocol class (abstract; subclass for custom vocabularies via SpecT) + types. NOT mergeCapabilities.
export type {
    BaseContext,
    ClientContext,
    LegacyContextFields,
    McpSpec,
    NotificationOptions,
    ProgressCallback,
    ProtocolOptions,
    ProtocolSpec,
    RequestHandlerExtra,
    RequestOptions,
    ServerContext,
    SpecNotifications,
    SpecRequests
} from '../../shared/protocol.js';
export { DEFAULT_REQUEST_TIMEOUT_MSEC, Protocol } from '../../shared/protocol.js';
export type { ZodLikeRequestSchema } from '../../util/compatSchema.js';

// Task manager types (NOT TaskManager class itself — internal)
export type { RequestTaskStore, TaskContext, TaskManagerOptions, TaskRequestOptions } from '../../shared/taskManager.js';

// Response message types
export type {
    BaseResponseMessage,
    ErrorMessage,
    ResponseMessage,
    ResultMessage,
    TaskCreatedMessage,
    TaskStatusMessage
} from '../../shared/responseMessage.js';
export { takeResult, toArrayAsync } from '../../shared/responseMessage.js';

// stdio message framing utilities (for custom transport authors)
export { deserializeMessage, ReadBuffer, serializeMessage } from '../../shared/stdio.js';

// Transport types (NOT normalizeHeaders)
export type { FetchLike, Transport, TransportSendOptions } from '../../shared/transport.js';
export { createFetchWithInit } from '../../shared/transport.js';
export { InMemoryTransport } from '../../util/inMemory.js';

// URI Template
export type { Variables } from '../../shared/uriTemplate.js';
export { UriTemplate } from '../../shared/uriTemplate.js';

// Types — all TypeScript types (standalone interfaces + schema-derived).
// This is the one intentional `export *`: types.ts contains only spec-derived TS
// types, and every type there should be public. See comment in types.ts.
export * from '../../types/types.js';

// Constants
export {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    RELATED_TASK_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../../types/constants.js';

// Enums
export { ProtocolErrorCode } from '../../types/enums.js';

// Error classes
export { ProtocolError, UrlElicitationRequiredError } from '../../types/errors.js';

// --- v1-compat aliases ---
import { SdkErrorCode as _SdkErrorCode } from '../../errors/sdkErrors.js';
import { ProtocolErrorCode as _ProtocolErrorCode } from '../../types/enums.js';
/**
 * @deprecated Use {@linkcode ProtocolErrorCode} for protocol-level (wire) errors
 * or {@linkcode SdkErrorCode} for local SDK errors. Note `ConnectionClosed` /
 * `RequestTimeout` moved to `SdkErrorCode` in v2 and are now thrown as `SdkError`,
 * not `ProtocolError`.
 */
export const ErrorCode = {
    ..._ProtocolErrorCode,
    /** Now {@linkcode SdkErrorCode.ConnectionClosed}; thrown as `SdkError`, not `McpError`. */
    ConnectionClosed: _SdkErrorCode.ConnectionClosed,
    /** Now {@linkcode SdkErrorCode.RequestTimeout}; thrown as `SdkError`, not `McpError`. */
    RequestTimeout: _SdkErrorCode.RequestTimeout
} as const;
/** @deprecated Use `ProtocolErrorCode` / `SdkErrorCode`. See {@linkcode ErrorCode} const. */
export type ErrorCode = _ProtocolErrorCode | typeof _SdkErrorCode.ConnectionClosed | typeof _SdkErrorCode.RequestTimeout;
export {
    /** @deprecated Use {@linkcode ProtocolError} (or `SdkError` for transport-level errors). */
    ProtocolError as McpError
} from '../../types/errors.js';
// Note: InvalidRequestError is intentionally omitted here — it collides with the
// JSON-RPC `InvalidRequestError` interface re-exported from types.ts below. v1 users
// imported it from `server/auth/errors.js`, which the sdk meta-package subpath provides.
export {
    AccessDeniedError,
    CustomOAuthError,
    InsufficientScopeError,
    InvalidClientError,
    InvalidClientMetadataError,
    InvalidGrantError,
    InvalidScopeError,
    InvalidTargetError,
    InvalidTokenError,
    MethodNotAllowedError,
    ServerError,
    TemporarilyUnavailableError,
    TooManyRequestsError,
    UnauthorizedClientError,
    UnsupportedGrantTypeError,
    UnsupportedResponseTypeError,
    UnsupportedTokenTypeError
} from '../../errors/oauthErrorsCompat.js';
export { StreamableHTTPError } from '../../errors/streamableHttpErrorCompat.js';
/** @deprecated Use {@linkcode JSONRPCErrorResponse}. */
export type { JSONRPCErrorResponse as JSONRPCError } from '../../types/spec.types.js';
// --- end v1-compat ---

// Type guards and message parsing
export {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    isCallToolResult,
    isInitializedNotification,
    isInitializeRequest,
    /** @deprecated Use {@linkcode isJSONRPCErrorResponse}. */
    isJSONRPCErrorResponse as isJSONRPCError,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResponse,
    isJSONRPCResultResponse,
    isTaskAugmentedRequestParams,
    parseJSONRPCMessage
} from '../../types/guards.js';

// Experimental task types and classes
export { assertClientRequestTaskCapability, assertToolsCallTaskCapability } from '../../experimental/tasks/helpers.js';
export type {
    BaseQueuedMessage,
    CreateTaskOptions,
    CreateTaskServerContext,
    QueuedError,
    QueuedMessage,
    QueuedNotification,
    QueuedRequest,
    QueuedResponse,
    TaskMessageQueue,
    TaskServerContext,
    TaskStore,
    TaskToolExecution
} from '../../experimental/tasks/interfaces.js';
export { isTerminal } from '../../experimental/tasks/interfaces.js';
export { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../experimental/tasks/stores/inMemory.js';

// Validator types and classes
export type { StandardSchemaV1, StandardSchemaWithJSON } from '../../util/standardSchema.js';
export { AjvJsonSchemaValidator } from '../../validators/ajvProvider.js';
export type { CfWorkerSchemaDraft } from '../../validators/cfWorkerProvider.js';
// fromJsonSchema is intentionally NOT exported here — the server and client packages
// provide runtime-aware wrappers that default to the appropriate validator via _shims.
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '../../validators/types.js';

// ────────────────────────────────────────────────────────────────────────────
// v1 backwards-compatibility type aliases
// ────────────────────────────────────────────────────────────────────────────

// Note: a `ResourceTemplate = ResourceTemplateType` alias is intentionally NOT
// exported here — it conflicts with the server's `ResourceTemplate` class under
// tsdown bundling. The alias lives only in the `/sdk` meta-package's `types.js`.

/**
 * @deprecated Use the standard `Headers` web type. v2 transports surface
 * request headers via `Headers` on `ctx.http?.req`.
 */
export type IsomorphicHeaders = Headers;

/**
 * @deprecated Use the standard `Request` web type. v2's {@linkcode ServerContext}
 * exposes the originating HTTP request at `ctx.http?.req`.
 */
export type RequestInfo = globalThis.Request;

// `FetchLike` keeps its v1 name and is re-exported above from
// '../../shared/transport.js' — no alias needed.
