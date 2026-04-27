/**
 * Curated public API exports for @modelcontextprotocol/core.
 *
 * This module defines the stable, public-facing API surface. Client and server
 * packages re-export from here so that end users only see supported symbols.
 *
 * Internal utilities (Protocol class, stdio parsing, schema helpers, etc.)
 * remain available via the internal barrel (@modelcontextprotocol/core) for
 * use by client/server packages.
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

// Protocol types (NOT the Protocol class itself or mergeCapabilities)
export type {
    BaseContext,
    ClientContext,
    NotificationOptions,
    ProgressCallback,
    ProtocolOptions,
    RequestHandlerSchemas,
    RequestOptions,
    ServerContext
} from '../../shared/protocol.js';
export { DEFAULT_REQUEST_TIMEOUT_MSEC } from '../../shared/protocol.js';

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

// Type guards and message parsing
export {
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    isCallToolResult,
    isInitializedNotification,
    isInitializeRequest,
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
export type { SpecTypeName, SpecTypes } from '../../types/specTypeSchema.js';
export { isSpecType, specTypeSchemas } from '../../types/specTypeSchema.js';
export type { StandardSchemaV1, StandardSchemaWithJSON } from '../../util/standardSchema.js';
export { AjvJsonSchemaValidator } from '../../validators/ajvProvider.js';
export type { CfWorkerSchemaDraft } from '../../validators/cfWorkerProvider.js';
// fromJsonSchema is intentionally NOT exported here — the server and client packages
// provide runtime-aware wrappers that default to the appropriate validator via _shims.
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '../../validators/types.js';
