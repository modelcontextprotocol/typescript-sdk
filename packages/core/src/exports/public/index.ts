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
export * from '../../auth/errors.js';

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
    RequestOptions,
    RequestTaskStore,
    ServerContext,
    TaskContext,
    TaskRequestOptions
} from '../../shared/protocol.js';
export { DEFAULT_REQUEST_TIMEOUT_MSEC } from '../../shared/protocol.js';

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

// Transport types (NOT normalizeHeaders)
export type { FetchLike, Transport, TransportSendOptions } from '../../shared/transport.js';
export { createFetchWithInit } from '../../shared/transport.js';

// URI Template
export type { Variables } from '../../shared/uriTemplate.js';
export { UriTemplate } from '../../shared/uriTemplate.js';

// Types — all TypeScript types (standalone interfaces + schema-derived)
export * from '../../types/types.js';

// Constants
export * from '../../types/constants.js';

// Enums
export * from '../../types/enums.js';

// Error classes
export * from '../../types/errors.js';

// Type guards
export * from '../../types/guards.js';

// Experimental task types and classes
export * from '../../experimental/index.js';

// Validator types and classes
export * from '../../validators/ajvProvider.js';
export * from '../../validators/cfWorkerProvider.js';
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '../../validators/types.js';
