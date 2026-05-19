/**
 * Pre-2026 wire types and schemas.
 *
 * These types represent JSON-RPC methods and notifications that were part of
 * MCP up to and including 2025-11-25 but are removed from the 2026-06 draft
 * spec. They are NOT in the current `spec.types.ts` (regenerated from the
 * spec repo) and are SDK-maintained here so `LegacyServer` / `LegacyClient`
 * can continue to speak the pre-2026 wire protocol.
 *
 * Deleted when pre-2026 protocol support is dropped.
 */
import * as z from 'zod/v4';

import {
    ClientCapabilitiesSchema,
    ImplementationSchema,
    LoggingLevelSchema,
    NotificationSchema,
    ProgressTokenSchema,
    registerLegacySchemas,
    ServerCapabilitiesSchema
} from './schemas.js';
import type {
    ClientCapabilities,
    Implementation,
    JSONRPCNotification,
    JSONRPCRequest,
    LoggingLevel,
    MetaObject,
    NotificationParams,
    ProgressToken,
    ServerCapabilities
} from './spec.types.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* Legacy base shapes                                                         */
/*                                                                            */
/* The 2026-06 spec's `RequestParams._meta` is required and carries           */
/* namespaced `io.modelcontextprotocol/*` keys. Pre-2026 requests have an     */
/* optional `_meta` with only `progressToken`. These local base types let     */
/* the legacy interfaces below avoid the strict 2026 shape.                   */
/* ────────────────────────────────────────────────────────────────────────── */

/** Pre-2026 `_meta` shape: only `progressToken`, no namespaced keys. */
export interface LegacyRequestMetaObject extends MetaObject {
    progressToken?: ProgressToken;
}

/** Pre-2026 request params: `_meta` is optional. */
export interface LegacyRequestParams {
    _meta?: LegacyRequestMetaObject;
    [key: string]: unknown;
}

/** Pre-2026 result: no `resultType`. */
export interface LegacyResult {
    _meta?: MetaObject;
    [key: string]: unknown;
}

/* Zod base shapes for legacy schemas. Kept separate from `schemas.ts` so the
 * 2026 file is spec-only at the source level. The shapes here are the pre-2026
 * wire format (no namespaced `_meta` keys, no `resultType`). */

const LegacyRequestMetaSchema = z.looseObject({
    progressToken: ProgressTokenSchema.optional()
});

const LegacyBaseRequestParamsSchema = z.object({
    _meta: LegacyRequestMetaSchema.optional()
});

const LegacyRequestSchema = z.object({
    method: z.string(),
    params: LegacyBaseRequestParamsSchema.loose().optional()
});

const LegacyResultSchema = z.looseObject({
    _meta: z.record(z.string(), z.unknown()).optional()
});

/* ────────────────────────────────────────────────────────────────────────── */
/* `initialize` / `notifications/initialized`                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface InitializeRequestParams extends LegacyRequestParams {
    /**
     * The latest version of the Model Context Protocol that the client
     * supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: Implementation;
}

export interface InitializeRequest extends JSONRPCRequest {
    method: 'initialize';
    params: InitializeRequestParams;
}

export interface InitializeResult extends LegacyResult {
    /**
     * The version of the Model Context Protocol that the server wants to use.
     * This may not match the version that the client requested. If the client
     * cannot support this version, it MUST disconnect.
     */
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: Implementation;
    /**
     * Instructions describing how to use the server and its features.
     */
    instructions?: string;
}

export interface InitializedNotification extends JSONRPCNotification {
    method: 'notifications/initialized';
    params?: NotificationParams;
}

export const InitializeRequestParamsSchema = LegacyBaseRequestParamsSchema.extend({
    protocolVersion: z.string(),
    capabilities: ClientCapabilitiesSchema,
    clientInfo: ImplementationSchema
});

export const InitializeRequestSchema = LegacyRequestSchema.extend({
    method: z.literal('initialize'),
    params: InitializeRequestParamsSchema
});

export const InitializeResultSchema = LegacyResultSchema.extend({
    protocolVersion: z.string(),
    capabilities: ServerCapabilitiesSchema,
    serverInfo: ImplementationSchema,
    instructions: z.string().optional()
});

export const InitializedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/initialized')
});

/* ────────────────────────────────────────────────────────────────────────── */
/* `ping`                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PingRequest extends JSONRPCRequest {
    method: 'ping';
    params?: LegacyRequestParams;
}

export const PingRequestSchema = LegacyRequestSchema.extend({
    method: z.literal('ping')
});

/* ────────────────────────────────────────────────────────────────────────── */
/* `logging/setLevel`                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SetLevelRequestParams extends LegacyRequestParams {
    /**
     * The level of logging that the client wants to receive from the server.
     */
    level: LoggingLevel;
}

export interface SetLevelRequest extends JSONRPCRequest {
    method: 'logging/setLevel';
    params: SetLevelRequestParams;
}

export const SetLevelRequestParamsSchema = LegacyBaseRequestParamsSchema.extend({
    level: LoggingLevelSchema
});

export const SetLevelRequestSchema = LegacyRequestSchema.extend({
    method: z.literal('logging/setLevel'),
    params: SetLevelRequestParamsSchema
});

/* ────────────────────────────────────────────────────────────────────────── */
/* `resources/subscribe` / `resources/unsubscribe`                            */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SubscribeRequestParams extends LegacyRequestParams {
    /** The URI of the resource to subscribe to. */
    uri: string;
}

export interface SubscribeRequest extends JSONRPCRequest {
    method: 'resources/subscribe';
    params: SubscribeRequestParams;
}

export type UnsubscribeRequestParams = SubscribeRequestParams;

export interface UnsubscribeRequest extends JSONRPCRequest {
    method: 'resources/unsubscribe';
    params: UnsubscribeRequestParams;
}

export const SubscribeRequestParamsSchema = LegacyBaseRequestParamsSchema.extend({
    uri: z.string()
});

export const SubscribeRequestSchema = LegacyRequestSchema.extend({
    method: z.literal('resources/subscribe'),
    params: SubscribeRequestParamsSchema
});

export const UnsubscribeRequestParamsSchema = SubscribeRequestParamsSchema;

export const UnsubscribeRequestSchema = LegacyRequestSchema.extend({
    method: z.literal('resources/unsubscribe'),
    params: UnsubscribeRequestParamsSchema
});

/* ────────────────────────────────────────────────────────────────────────── */
/* `notifications/roots/list_changed` (client → server)                       */
/* ────────────────────────────────────────────────────────────────────────── */

export interface RootsListChangedNotification extends JSONRPCNotification {
    method: 'notifications/roots/list_changed';
    params?: NotificationParams;
}

export const RootsListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/roots/list_changed')
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Maps for legacy method/result/notification dispatch                        */
/* ────────────────────────────────────────────────────────────────────────── */

/** Legacy request methods that are not in the 2026-06 `RequestTypeMap`. */
export const legacyRequestSchemas = {
    initialize: InitializeRequestSchema,
    ping: PingRequestSchema,
    'logging/setLevel': SetLevelRequestSchema,
    'resources/subscribe': SubscribeRequestSchema,
    'resources/unsubscribe': UnsubscribeRequestSchema
} as const;

/** Legacy result schemas keyed by request method. */
export const legacyResultSchemas = {
    initialize: InitializeResultSchema,
    ping: LegacyResultSchema,
    'logging/setLevel': LegacyResultSchema,
    'resources/subscribe': LegacyResultSchema,
    'resources/unsubscribe': LegacyResultSchema
} as const;

/** Legacy notification methods that are not in the 2026-06 `NotificationTypeMap`. */
export const legacyNotificationSchemas = {
    'notifications/initialized': InitializedNotificationSchema,
    'notifications/roots/list_changed': RootsListChangedNotificationSchema
} as const;

export type LegacyRequestMethod = keyof typeof legacyRequestSchemas;
export type LegacyNotificationMethod = keyof typeof legacyNotificationSchemas;

// Merge into the runtime lookup maps so `getRequestSchema('initialize')` etc.
// continue to work. Runs at module load (this file is barrel-imported).
registerLegacySchemas({
    requests: legacyRequestSchemas,
    results: legacyResultSchemas,
    notifications: legacyNotificationSchemas
});
