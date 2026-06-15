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
 * is the runtime/typed ALIGNED map (PR #2293 review): keyed by
 * `RequestMethod` so it cannot drift from the typed `ResultTypeMap` — no
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

import {
    CallToolResultSchema,
    CompleteResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    GetPromptResultSchema,
    InitializeResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListRootsResultSchema,
    ListToolsResultSchema,
    ReadResourceResultSchema
} from '../../types/schemas.js';
import type { NotificationMethod, NotificationTypeMap, RequestMethod, RequestTypeMap, ResultTypeMap } from '../../types/types.js';
import { ClientNotificationSchema, ClientRequestSchema, ServerNotificationSchema, ServerRequestSchema } from './schemas.js';

/* Runtime schema lookup — result schemas by method */
// Keyed by `RequestMethod` so the runtime map and the typed `ResultTypeMap`
// cannot drift: `getResultSchema`'s typed overload asserts each entry parses
// to `ResultTypeMap[M]`, so no entry may be looser than the typed map
// (no task-result union members) and no key may fall outside it (no `tasks/*`
// entries — the task methods are 2025-11-25 wire vocabulary with no SDK
// runtime; callers needing task interop pass an explicit schema).
const resultSchemas: Record<RequestMethod, z.core.$ZodType> = {
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

/**
 * Gets the Zod schema for validating results of a given request method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for explanation of the internal type assertion.
 */
export function getResultSchema<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]>;
export function getResultSchema(method: string): z.ZodType | undefined;
export function getResultSchema(method: string): z.ZodType | undefined {
    return resultSchemas[method as RequestMethod] as unknown as z.ZodType | undefined;
}

/* Runtime schema lookup — request schemas by method */
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

/**
 * Gets the Zod schema for a given request method.
 * Returns `undefined` for non-spec methods.
 * The return type is a ZodType that parses to RequestTypeMap[M], allowing callers
 * to use schema.parse() without needing additional type assertions.
 *
 * Note: The internal cast is necessary because TypeScript can't correlate the
 * Record-based schema lookup with the MethodToTypeMap-based RequestTypeMap
 * when M is a generic type parameter. Both compute to the same type at
 * instantiation, but TypeScript can't prove this statically.
 */
export function getRequestSchema<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]>;
export function getRequestSchema(method: string): z.ZodType | undefined;
export function getRequestSchema(method: string): z.ZodType | undefined {
    return requestSchemas[method as RequestMethod] as unknown as z.ZodType | undefined;
}

/**
 * Gets the Zod schema for a given notification method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for explanation of the internal type assertion.
 */
export function getNotificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]>;
export function getNotificationSchema(method: string): z.ZodType | undefined;
export function getNotificationSchema(method: string): z.ZodType | undefined {
    return notificationSchemas[method as NotificationMethod] as unknown as z.ZodType | undefined;
}

/** The 2025-era request-method set (registry membership = the deletion story). */
export function hasRequestMethod2025(method: string): boolean {
    return Object.prototype.hasOwnProperty.call(requestSchemas, method);
}

/** The 2025-era notification-method set. */
export function hasNotificationMethod2025(method: string): boolean {
    return Object.prototype.hasOwnProperty.call(notificationSchemas, method);
}

/** Registry method lists (for the spec-method universe and the CI registry-diff oracle). */
export const rev2025RequestMethods: readonly string[] = Object.keys(requestSchemas);
export const rev2025NotificationMethods: readonly string[] = Object.keys(notificationSchemas);
