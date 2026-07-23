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
 *
 * LAZY SCHEMA CONSTRUCTION: method membership and the exported method lists
 * are static (null-valued key objects below — the mapped-type keying keeps
 * the both-direction drift guard), while the schema VALUES are pulled through
 * the era's memoized `buildSchemas2025()` factory on first lookup. Importing
 * this module therefore constructs no zod schemas; the first validation does,
 * once, and every consumer (registry, codec, the eager `schemas.ts` shim)
 * sees the same objects, so the by-reference pins keep holding.
 */
import type * as z from 'zod/v4';

import type { NotificationMethod, NotificationTypeMap, RequestMethod, RequestTypeMap, ResultTypeMap } from '../../types/types';
import type { Rev2025WireSchemas } from './buildSchemas';
import { buildSchemas2025 } from './buildSchemas';

/* The era's wire vocabulary, derived from the wire role unions in
 * `./buildSchemas.ts` (the same unions the registries used to be built from
 * at runtime). Keying the maps by these derived unions makes drift a compile
 * error in BOTH directions: a union member without a map entry, a map entry
 * the unions do not know, and an entry pointing at a different method's
 * schema all fail to typecheck. */
type WireRequest = z.output<Rev2025WireSchemas['ClientRequestSchema']> | z.output<Rev2025WireSchemas['ServerRequestSchema']>;
type WireNotification = z.output<Rev2025WireSchemas['ClientNotificationSchema']> | z.output<Rev2025WireSchemas['ServerNotificationSchema']>;

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

/* Static method membership — the schema-free half of the registry.
 *
 * These null-valued objects carry ONLY the method keys, in the same order the
 * eager schema maps used to declare them (so the exported method lists stay
 * byte-identical to the pre-lazy builder). The mapped-type keying preserves
 * the both-direction drift guard: a union member without a key, or a key the
 * union does not know, is a compile error. Membership checks and the exported
 * lists read these objects and never touch the schema memo. */
const requestMethodKeys: { readonly [M in Rev2025RequestMethod]: null } = {
    ping: null,
    initialize: null,
    'completion/complete': null,
    'logging/setLevel': null,
    'prompts/get': null,
    'prompts/list': null,
    'resources/list': null,
    'resources/templates/list': null,
    'resources/read': null,
    'resources/subscribe': null,
    'resources/unsubscribe': null,
    'tools/call': null,
    'tools/list': null,
    'tasks/get': null,
    'tasks/result': null,
    'tasks/list': null,
    'tasks/cancel': null,
    'sampling/createMessage': null,
    'elicitation/create': null,
    'roots/list': null
};

const notificationMethodKeys: { readonly [M in Rev2025NotificationMethod]: null } = {
    'notifications/cancelled': null,
    'notifications/progress': null,
    'notifications/initialized': null,
    'notifications/roots/list_changed': null,
    'notifications/tasks/status': null,
    'notifications/message': null,
    'notifications/resources/updated': null,
    'notifications/resources/list_changed': null,
    'notifications/tools/list_changed': null,
    'notifications/prompts/list_changed': null,
    'notifications/elicitation/complete': null
};

const resultMethodKeys: { readonly [M in Rev2025TypedRequestMethod]: null } = {
    ping: null,
    initialize: null,
    'completion/complete': null,
    'logging/setLevel': null,
    'prompts/get': null,
    'prompts/list': null,
    'resources/list': null,
    'resources/templates/list': null,
    'resources/read': null,
    'resources/subscribe': null,
    'resources/unsubscribe': null,
    'tools/call': null,
    'tools/list': null,
    'sampling/createMessage': null,
    'elicitation/create': null,
    'roots/list': null
};

/* Lazy schema maps — built once, on the first schema lookup, from the era's
 * memoized schema factory. The entries are the SAME schema objects the wire
 * role unions are built from (reference identity is pinned by
 * `test/types/registryPins.test.ts`), and the key order preserves the
 * pre-split union iteration order. The mapped types below are unchanged from
 * the eager maps, so the drift guards still apply entry by entry. */
interface RegistryMaps {
    /* Runtime schema lookup — request and notification schemas by method. */
    readonly requestSchemas: { readonly [M in Rev2025RequestMethod]: z.ZodType<Extract<WireRequest, { method: M }>> };
    readonly notificationSchemas: { readonly [M in Rev2025NotificationMethod]: z.ZodType<Extract<WireNotification, { method: M }>> };
    /* Runtime schema lookup — result schemas by method.
     *
     * Keyed by the era's typed-method subset and valued by
     * `z.ZodType<ResultTypeMap[M]>` so the runtime map and the typed
     * `ResultTypeMap` cannot drift: a missing entry, an extra key, or an entry
     * that does not parse to the typed map's result type is a compile error. No
     * entry may be looser than the typed map (no task-result union members) and
     * no key may fall outside it (no `tasks/*` entries — the task methods are
     * 2025-11-25 wire vocabulary with no SDK runtime; callers needing task
     * interop pass an explicit schema). The `tools/call` entry is the wire-seam
     * wrapper `CallToolResultWireSchema` (content-default guard + tolerance),
     * which lives with the era schemas in `./buildSchemas.ts`. */
    readonly resultSchemas: { readonly [M in Rev2025TypedRequestMethod]: z.ZodType<ResultTypeMap[M]> };
}

let maps: RegistryMaps | undefined;

function registryMaps(): RegistryMaps {
    if (maps) return maps;
    const s = buildSchemas2025();
    maps = {
        requestSchemas: {
            ping: s.PingRequestSchema,
            initialize: s.InitializeRequestSchema,
            'completion/complete': s.CompleteRequestSchema,
            'logging/setLevel': s.SetLevelRequestSchema,
            'prompts/get': s.GetPromptRequestSchema,
            'prompts/list': s.ListPromptsRequestSchema,
            'resources/list': s.ListResourcesRequestSchema,
            'resources/templates/list': s.ListResourceTemplatesRequestSchema,
            'resources/read': s.ReadResourceRequestSchema,
            'resources/subscribe': s.SubscribeRequestSchema,
            'resources/unsubscribe': s.UnsubscribeRequestSchema,
            'tools/call': s.CallToolRequestSchema,
            'tools/list': s.ListToolsRequestSchema,
            'tasks/get': s.GetTaskRequestSchema,
            'tasks/result': s.GetTaskPayloadRequestSchema,
            'tasks/list': s.ListTasksRequestSchema,
            'tasks/cancel': s.CancelTaskRequestSchema,
            'sampling/createMessage': s.CreateMessageRequestSchema,
            'elicitation/create': s.ElicitRequestSchema,
            'roots/list': s.ListRootsRequestSchema
        },
        notificationSchemas: {
            'notifications/cancelled': s.CancelledNotificationSchema,
            'notifications/progress': s.ProgressNotificationSchema,
            'notifications/initialized': s.InitializedNotificationSchema,
            'notifications/roots/list_changed': s.RootsListChangedNotificationSchema,
            'notifications/tasks/status': s.TaskStatusNotificationSchema,
            'notifications/message': s.LoggingMessageNotificationSchema,
            'notifications/resources/updated': s.ResourceUpdatedNotificationSchema,
            'notifications/resources/list_changed': s.ResourceListChangedNotificationSchema,
            'notifications/tools/list_changed': s.ToolListChangedNotificationSchema,
            'notifications/prompts/list_changed': s.PromptListChangedNotificationSchema,
            'notifications/elicitation/complete': s.ElicitationCompleteNotificationSchema
        },
        resultSchemas: {
            ping: s.EmptyResultSchema,
            initialize: s.InitializeResultSchema,
            'completion/complete': s.CompleteResultSchema,
            'logging/setLevel': s.EmptyResultSchema,
            'prompts/get': s.GetPromptResultSchema,
            'prompts/list': s.ListPromptsResultSchema,
            'resources/list': s.ListResourcesResultSchema,
            'resources/templates/list': s.ListResourceTemplatesResultSchema,
            'resources/read': s.ReadResourceResultSchema,
            'resources/subscribe': s.EmptyResultSchema,
            'resources/unsubscribe': s.EmptyResultSchema,
            'tools/call': s.CallToolResultWireSchema,
            'tools/list': s.ListToolsResultSchema,
            'sampling/createMessage': s.CreateMessageResultWithToolsSchema,
            'elicitation/create': s.ElicitResultSchema,
            'roots/list': s.ListRootsResultSchema
        }
    };
    return maps;
}

/**
 * Forces the lazy registry maps (and, through them, the era's schema memo).
 * Warm-up hook for `preloadSchemas()` — no-op once the maps exist.
 */
export function warmRegistryMaps2025(): void {
    registryMaps();
}

/** The 2025-era request-method set (registry membership = the deletion story). */
export function hasRequestMethod2025(method: string): method is Rev2025RequestMethod {
    return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
}

/** The 2025-era notification-method set. */
export function hasNotificationMethod2025(method: string): method is Rev2025NotificationMethod {
    return Object.prototype.hasOwnProperty.call(notificationMethodKeys, method);
}

/** Result-map membership: exactly the era's typed-method subset (no task entries, no 2026-only methods). */
function hasResultMethod(method: string): method is Rev2025TypedRequestMethod {
    return Object.prototype.hasOwnProperty.call(resultMethodKeys, method);
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
    return hasResultMethod(method) ? registryMaps().resultSchemas[method] : undefined;
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
    return hasRequestMethod2025(method) ? registryMaps().requestSchemas[method] : undefined;
}

/**
 * Gets the Zod schema for a given notification method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for the typed-overload contract.
 */
export function getNotificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]>;
export function getNotificationSchema(method: string): z.ZodType | undefined;
export function getNotificationSchema(method: string): z.ZodType | undefined {
    return hasNotificationMethod2025(method) ? registryMaps().notificationSchemas[method] : undefined;
}

/** Registry method lists (for the spec-method universe and the CI registry-diff oracle). */
export const rev2025RequestMethods: readonly string[] = Object.keys(requestMethodKeys);
export const rev2025NotificationMethods: readonly string[] = Object.keys(notificationMethodKeys);
