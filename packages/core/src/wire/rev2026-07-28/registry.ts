/**
 * The 2026-era method registries (protocol revision 2026-07-28).
 *
 * Registry membership IS the deletion story: there are NO entries for
 * `initialize`, `notifications/initialized`, `ping`, `logging/setLevel`,
 * `resources/subscribe`, `resources/unsubscribe`,
 * `notifications/roots/list_changed`, the task family, or the server→client
 * wire-request channel — so an era-mismatched method falls to −32601 by
 * absence inbound and a typed local error outbound, with no table to forget.
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

import { dispatchRequestSchemas, dispatchResultSchemas, notificationSchemas2026 } from './schemas.js';

export function hasRequestMethod2026(method: string): boolean {
    return Object.prototype.hasOwnProperty.call(dispatchRequestSchemas, method);
}

export function hasNotificationMethod2026(method: string): boolean {
    return Object.prototype.hasOwnProperty.call(notificationSchemas2026, method);
}

export function getRequestSchema2026(method: string): z.ZodType | undefined {
    return dispatchRequestSchemas[method];
}

export function getResultSchema2026(method: string): z.ZodType | undefined {
    return dispatchResultSchemas[method];
}

export function getNotificationSchema2026(method: string): z.ZodType | undefined {
    return notificationSchemas2026[method];
}

/** Registry method lists (for the spec-method universe and the CI registry-diff oracle). */
export const rev2026RequestMethods: readonly string[] = Object.keys(dispatchRequestSchemas);
export const rev2026NotificationMethods: readonly string[] = Object.keys(notificationSchemas2026);

/** Narrow high-level result schemas for this era (see `codec.ts`
 * `NarrowResultKey`). Deliberately EMPTY: the only narrow surface is the
 * sampling pair, and sampling is not a wire request on this era (demoted to
 * in-band `InputRequest` payloads), so `server.createMessage` fails with the
 * typed era error before schema resolution. `tools/call` validates its
 * registry entry directly — with the result maps aligned to the typed maps
 * there is no narrower tools/call surface on any era. */
export const narrowResultSchemas2026: Record<string, z.ZodType> = {};
