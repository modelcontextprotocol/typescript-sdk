/**
 * The 2025-era method registries — re-homed verbatim from
 * `types/schemas.ts` (Q1 increment-2 step 1: mechanical relocation behind the
 * codec interface; the registry CONTENT is byte-identical to the pre-split
 * maps and is pinned by reference in `test/types/registryPins.test.ts`).
 *
 * This era serves all five legacy protocol versions (2024-10-07 …
 * 2025-11-25), exactly as the single schema set did before the split. It is
 * BEHAVIOR-FROZEN behind the Q10-L2 byte-identity suite: the request and
 * notification maps carry the full deliberate 2025-11-25 wire vocabulary,
 * including the task family (the #2248 wire-interop restore). The RESULT map
 * is the runtime/typed ALIGNED map (PR #2293 review): keyed by this era's
 * subset of the typed `RequestMethod` set so it cannot drift from the typed
 * `ResultTypeMap` — no
 * task-result union members and no `tasks/*` entries; a task-capable 2025
 * peer's `CreateTaskResult` answer fails the plain per-method schema as a
 * typed invalid-result error, and callers needing task interop pass an
 * explicit result schema (see `test/shared/typedMapAlignment.test.ts`).
 *
 * 2026-only vocabulary (`server/discover`, `subscriptions/listen`, the MRTR
 * shells, `resultType`, the `_meta` envelope) has NO entry and NO code path
 * here — the inverse-leak guarantee is physical absence, not discipline.
 */
import type * as z from 'zod/v4';

import type { NotificationMethod, NotificationTypeMap, RequestMethod, RequestTypeMap, ResultTypeMap } from '../../types/types.js';
import type { ClientNotificationSchema, ClientRequestSchema, ServerNotificationSchema, ServerRequestSchema } from './schemas.js';
import {
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationSchema,
    CancelTaskRequestSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultWithToolsSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    InitializedNotificationSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListTasksRequestSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    LoggingMessageNotificationSchema,
    PingRequestSchema,
    ProgressNotificationSchema,
    PromptListChangedNotificationSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    RootsListChangedNotificationSchema,
    SetLevelRequestSchema,
    SubscribeRequestSchema,
    TaskStatusNotificationSchema,
    ToolListChangedNotificationSchema,
    UnsubscribeRequestSchema
} from './schemas.js';

/* The era's wire vocabulary, derived from the wire role unions in
 * `./schemas.ts` (the same unions the registries used to be built from at
 * runtime). Keying the maps by these derived unions makes drift a compile
 * error in BOTH directions: a union member without a map entry, a map entry
 * the unions do not know, and an entry pointing at a different method's
 * schema all fail to typecheck. */
type WireRequest = z.output<typeof ClientRequestSchema> | z.output<typeof ServerRequestSchema>;
type WireNotification = z.output<typeof ClientNotificationSchema> | z.output<typeof ServerNotificationSchema>;

/** Every request method in the 2025-era wire vocabulary (the typed `RequestMethod` surface plus the task family). */
export type Rev2025RequestMethod = WireRequest['method'];
/** Every notification method in the 2025-era wire vocabulary. */
export type Rev2025NotificationMethod = WireNotification['method'];

/**
 * The typed-method surface this era serves: the typed `RequestMethod` set
 * minus methods whose wire vocabulary does not exist on this era (e.g.
 * `server/discover`, which the typed maps carry but only the 2026-era
 * registry serves). Deriving the subset from the era's own wire role unions
 * keeps the both-direction drift guard: a typed 2025-era method without a map
 * entry, or a map entry the era's wire vocabulary does not know, is a compile
 * error.
 */
type Rev2025TypedRequestMethod = Extract<RequestMethod, Rev2025RequestMethod>;

/* Runtime schema lookup — result schemas by method */
// Keyed by the era's typed-method subset and valued by
// `z.ZodType<ResultTypeMap[M]>` so the runtime map and the typed
// `ResultTypeMap` cannot drift: a missing entry, an extra key, or an entry
// that does not parse to the typed map's result type is a compile error. No
// entry may be looser than the typed map (no task-result union members) and
// no key may fall outside it (no `tasks/*` entries — the task methods are
// 2025-11-25 wire vocabulary with no SDK runtime; callers needing task
// interop pass an explicit schema).
const resultSchemas: { readonly [M in Rev2025TypedRequestMethod]: z.ZodType<ResultTypeMap[M]> } = {
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
    'tools/call': CallToolResultSchema,
    'tools/list': ListToolsResultSchema,
    'sampling/createMessage': CreateMessageResultWithToolsSchema,
    'elicitation/create': ElicitResultSchema,
    'roots/list': ListRootsResultSchema
};

/* Runtime schema lookup — request and notification schemas by method.
 *
 * The entries are the SAME schema objects the wire role unions are built
 * from (reference identity is pinned by `test/types/registryPins.test.ts`),
 * and the key order preserves the pre-split union iteration order so the
 * exported method lists are byte-identical to the builder they replace. */
const requestSchemas: { readonly [M in Rev2025RequestMethod]: z.ZodType<Extract<WireRequest, { method: M }>> } = {
    ping: PingRequestSchema,
    initialize: InitializeRequestSchema,
    'completion/complete': CompleteRequestSchema,
    'logging/setLevel': SetLevelRequestSchema,
    'prompts/get': GetPromptRequestSchema,
    'prompts/list': ListPromptsRequestSchema,
    'resources/list': ListResourcesRequestSchema,
    'resources/templates/list': ListResourceTemplatesRequestSchema,
    'resources/read': ReadResourceRequestSchema,
    'resources/subscribe': SubscribeRequestSchema,
    'resources/unsubscribe': UnsubscribeRequestSchema,
    'tools/call': CallToolRequestSchema,
    'tools/list': ListToolsRequestSchema,
    'tasks/get': GetTaskRequestSchema,
    'tasks/result': GetTaskPayloadRequestSchema,
    'tasks/list': ListTasksRequestSchema,
    'tasks/cancel': CancelTaskRequestSchema,
    'sampling/createMessage': CreateMessageRequestSchema,
    'elicitation/create': ElicitRequestSchema,
    'roots/list': ListRootsRequestSchema
};

const notificationSchemas: { readonly [M in Rev2025NotificationMethod]: z.ZodType<Extract<WireNotification, { method: M }>> } = {
    'notifications/cancelled': CancelledNotificationSchema,
    'notifications/progress': ProgressNotificationSchema,
    'notifications/initialized': InitializedNotificationSchema,
    'notifications/roots/list_changed': RootsListChangedNotificationSchema,
    'notifications/tasks/status': TaskStatusNotificationSchema,
    'notifications/message': LoggingMessageNotificationSchema,
    'notifications/resources/updated': ResourceUpdatedNotificationSchema,
    'notifications/resources/list_changed': ResourceListChangedNotificationSchema,
    'notifications/tools/list_changed': ToolListChangedNotificationSchema,
    'notifications/prompts/list_changed': PromptListChangedNotificationSchema,
    'notifications/elicitation/complete': ElicitationCompleteNotificationSchema
};

/** The 2025-era request-method set (registry membership = the deletion story). */
export function hasRequestMethod2025(method: string): method is Rev2025RequestMethod {
    return Object.prototype.hasOwnProperty.call(requestSchemas, method);
}

/** The 2025-era notification-method set. */
export function hasNotificationMethod2025(method: string): method is Rev2025NotificationMethod {
    return Object.prototype.hasOwnProperty.call(notificationSchemas, method);
}

/** Result-map membership: exactly the era's typed-method subset (no task entries, no 2026-only methods). */
function hasResultMethod(method: string): method is Rev2025TypedRequestMethod {
    return Object.prototype.hasOwnProperty.call(resultSchemas, method);
}

/**
 * Gets the Zod schema for validating results of a given request method.
 * Returns `undefined` for non-spec methods and 2026-only methods.
 * The typed overload is backed by the map's own typing (`z.ZodType<ResultTypeMap[M]>`
 * per entry), so callers with a statically known 2025-era method can use the
 * parsed value without a type assertion.
 */
export function getResultSchema<M extends Rev2025TypedRequestMethod>(method: M): z.ZodType<ResultTypeMap[M]>;
export function getResultSchema(method: string): z.ZodType | undefined;
export function getResultSchema(method: string): z.ZodType | undefined {
    return hasResultMethod(method) ? resultSchemas[method] : undefined;
}

/**
 * Gets the Zod schema for a given request method.
 * Returns `undefined` for non-spec methods and 2026-only methods.
 * The typed overload returns a ZodType that parses to `RequestTypeMap[M]`,
 * allowing callers to use `schema.parse()` without additional type assertions.
 */
export function getRequestSchema<M extends Rev2025TypedRequestMethod>(method: M): z.ZodType<RequestTypeMap[M]>;
export function getRequestSchema(method: string): z.ZodType | undefined;
export function getRequestSchema(method: string): z.ZodType | undefined {
    return hasRequestMethod2025(method) ? requestSchemas[method] : undefined;
}

/**
 * Gets the Zod schema for a given notification method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for the typed-overload contract.
 */
export function getNotificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]>;
export function getNotificationSchema(method: string): z.ZodType | undefined;
export function getNotificationSchema(method: string): z.ZodType | undefined {
    return hasNotificationMethod2025(method) ? notificationSchemas[method] : undefined;
}

/** Registry method lists (for the spec-method universe and the CI registry-diff oracle). */
export const rev2025RequestMethods: readonly string[] = Object.keys(requestSchemas);
export const rev2025NotificationMethods: readonly string[] = Object.keys(notificationSchemas);
