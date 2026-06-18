/**
 * The 2026-era method registries (protocol revision 2026-07-28).
 *
 * Registry membership IS the deletion story: there are NO entries for
 * `initialize`, `notifications/initialized`, `ping`, `logging/setLevel`,
 * `resources/subscribe`, `resources/unsubscribe`,
 * `notifications/roots/list_changed`, `notifications/elicitation/complete`
 * (removed from the draft schema; 2025-11-25-only vocabulary), the task
 * family, or the server→client wire-request channel — so an era-mismatched
 * method falls to −32601 by absence inbound and a typed local error outbound,
 * with no table to forget.
 *
 * HAND-REGISTRY SEED DECISIONS (pinned by the CI registry-diff oracle, which
 * fails LOUD if this list and the anchor diff ever disagree):
 * - `sampling/createMessage`, `elicitation/create`, `roots/list`: the anchor
 *   still carries their method literals on bare interfaces, but 2026 DEMOTES
 *   them from wire requests to in-band `InputRequest` payloads — the entire
 *   server→client JSON-RPC request channel is deleted (`ServerRequest` has
 *   no 2026 export). A generator walking method literals would re-admit them
 *   (the ATK-D flavor-b trap); this hand registry excludes them by
 *   construction. Their in-band role lands with the MRTR driver (#13).
 * - `subscriptions/listen` + `notifications/subscriptions/acknowledged`
 *   (SEP-1865): 2026-only vocabulary whose SHELLS land with the
 *   subscriptions feature (#14). Until then they are absent here — inbound
 *   listen gets −32601 (capability not yet served), which is protocol-legal
 *   for a server that does not implement subscriptions.
 */
import type * as z from 'zod/v4';

import type { NotificationMethod, NotificationTypeMap, RequestMethod, RequestTypeMap, ResultTypeMap } from '../../types/types.js';
import type { Rev2026NotificationMethod, Rev2026RequestMethod } from './schemas.js';
import { dispatchRequestSchemas, dispatchResultSchemas, notificationSchemas2026 } from './schemas.js';

/** The 2026-era request-method set (registry membership = the deletion story). */
export function hasRequestMethod2026(method: string): method is Rev2026RequestMethod {
    return Object.prototype.hasOwnProperty.call(dispatchRequestSchemas, method);
}

/** The 2026-era notification-method set. */
export function hasNotificationMethod2026(method: string): method is Rev2026NotificationMethod {
    return Object.prototype.hasOwnProperty.call(notificationSchemas2026, method);
}

/** Result-map membership (same key set as the request map on this era). */
function hasResultMethod2026(method: string): method is Rev2026RequestMethod {
    return Object.prototype.hasOwnProperty.call(dispatchResultSchemas, method);
}

/**
 * Gets the dispatch (post-lift) Zod schema for a given request method.
 * Returns `undefined` for methods this era's registry does not define.
 * The typed overload mirrors `WireCodec.requestSchema` so call sites with a
 * statically known method need no type assertion.
 */
export function getRequestSchema2026<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]> | undefined;
export function getRequestSchema2026(method: string): z.ZodType | undefined;
export function getRequestSchema2026(method: string): z.ZodType | undefined {
    return hasRequestMethod2026(method) ? dispatchRequestSchemas[method] : undefined;
}

/**
 * Gets the dispatch (post-lift) Zod schema for validating results of a given
 * request method. Returns `undefined` for methods this era's registry does
 * not define.
 * @see getRequestSchema2026 for the typed-overload contract.
 */
export function getResultSchema2026<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]> | undefined;
export function getResultSchema2026(method: string): z.ZodType | undefined;
export function getResultSchema2026(method: string): z.ZodType | undefined {
    return hasResultMethod2026(method) ? dispatchResultSchemas[method] : undefined;
}

/**
 * Gets the Zod schema for a given notification method.
 * Returns `undefined` for methods this era's registry does not define.
 * @see getRequestSchema2026 for the typed-overload contract.
 */
export function getNotificationSchema2026<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]> | undefined;
export function getNotificationSchema2026(method: string): z.ZodType | undefined;
export function getNotificationSchema2026(method: string): z.ZodType | undefined {
    return hasNotificationMethod2026(method) ? notificationSchemas2026[method] : undefined;
}

/** Registry method lists (for the spec-method universe and the CI registry-diff oracle). */
export const rev2026RequestMethods: readonly string[] = Object.keys(dispatchRequestSchemas);
export const rev2026NotificationMethods: readonly string[] = Object.keys(notificationSchemas2026);
