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
export type { SdkHttpErrorData } from '../../errors/sdkErrors.js';
export { SdkError, SdkErrorCode, SdkHttpError } from '../../errors/sdkErrors.js';

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

// stdio message framing utilities (for custom transport authors)
export { deserializeMessage, ReadBuffer, serializeMessage, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '../../shared/stdio.js';

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
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    LOG_LEVEL_META_KEY,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION_META_KEY,
    RELATED_TASK_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../../types/constants.js';

// Enums
export { ProtocolErrorCode } from '../../types/enums.js';

// Error classes
export { ProtocolError, UnsupportedProtocolVersionError, UrlElicitationRequiredError } from '../../types/errors.js';

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

// Validator types and classes
export type { SpecTypeName, SpecTypes } from '../../types/specTypeSchema.js';
export { isSpecType, specTypeSchemas } from '../../types/specTypeSchema.js';
export type { StandardSchemaV1, StandardSchemaV1Sync, StandardSchemaWithJSON } from '../../util/standardSchema.js';
// Validator providers are type-only here — import the runtime classes from the explicit
// `@modelcontextprotocol/{client,server}/validators/{ajv,cf-worker}` subpaths to customise.
export type { AjvJsonSchemaValidator } from '../../validators/ajvProvider.js';
export type { CfWorkerJsonSchemaValidator, CfWorkerSchemaDraft } from '../../validators/cfWorkerProvider.js';
// fromJsonSchema is intentionally NOT exported here — the server and client packages
// provide runtime-aware wrappers that default to the appropriate validator via _shims.
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '../../validators/types.js';
