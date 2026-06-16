/**
 * Client-capability requirements for inbound requests (protocol revision
 * 2026-07-28).
 *
 * The 2026-07-28 revision carries the client's declared capabilities on every
 * request (`io.modelcontextprotocol/clientCapabilities`), and a server MUST
 * NOT rely on capabilities the client did not declare: when processing a
 * request requires an undeclared capability, the server answers
 * `MissingRequiredClientCapabilityError` (`-32003`) with
 * `data.requiredCapabilities` listing what is missing — HTTP status `400` on
 * HTTP transports.
 *
 * This module is the shared, pure half of that rule. It is written for three
 * call sites:
 *
 * 1. the pre-dispatch feature gate at the HTTP entry (a request to a method
 *    whose processing structurally requires a client capability is refused
 *    before dispatch),
 * 2. the outbound input-request leg of multi round-trip requests (a server
 *    must not embed an input request the client cannot satisfy) — lands with
 *    the input-request engine,
 * 3. the legacy-session pre-check before bridging input requests onto a
 *    2025-era session — lands with that bridge.
 *
 * All three share {@linkcode missingClientCapabilities}; the per-method
 * requirement table below feeds call site 1 only.
 */
import type { ClientCapabilities } from '../types/types.js';

/**
 * Inbound request methods whose processing structurally requires a client
 * capability, keyed by method, valued by the capabilities required.
 *
 * Currently empty: none of the request methods served on the 2026-07-28
 * registry unconditionally requires a client capability. Entries appear here
 * when such methods exist — for example requests whose handling embeds
 * elicitation or sampling input requests (the input-request engine), or
 * opt-in subscription delivery. Handler-conditional requirements (a specific
 * tool that needs sampling) are not expressible as a static method table and
 * are enforced at the point the requirement arises instead.
 */
export const REQUIRED_CLIENT_CAPABILITIES_BY_METHOD: Readonly<Record<string, ClientCapabilities>> = {};

/**
 * The client capabilities a request method structurally requires, or
 * `undefined` when the method has no static requirement.
 */
export function requiredClientCapabilitiesForRequest(method: string): ClientCapabilities | undefined {
    return Object.hasOwn(REQUIRED_CLIENT_CAPABILITIES_BY_METHOD, method) ? REQUIRED_CLIENT_CAPABILITIES_BY_METHOD[method] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Computes the subset of `required` client capabilities the client did not
 * declare. Returns `undefined` when every required capability is declared;
 * otherwise returns an object in the `ClientCapabilities` shape containing
 * exactly the missing capabilities (suitable for
 * `data.requiredCapabilities` on the `-32003` error).
 *
 * A capability counts as declared when its top-level key is present on the
 * declared capabilities; when the requirement names nested members (for
 * example `elicitation: { url: {} }`), each named member must also be present
 * under the declared capability. An absent or empty `declared` value means
 * nothing is declared — every required capability is missing (the structural
 * clean-refusal posture for sessions with no per-request capability view).
 */
export function missingClientCapabilities(
    required: ClientCapabilities,
    declared: ClientCapabilities | undefined
): ClientCapabilities | undefined {
    const missing: Record<string, unknown> = {};

    for (const [capability, requirement] of Object.entries(required)) {
        if (requirement === undefined) {
            continue;
        }
        const declaredValue = declared === undefined ? undefined : (declared as Record<string, unknown>)[capability];
        if (declaredValue === undefined) {
            missing[capability] = requirement;
            continue;
        }
        if (isPlainObject(requirement) && isPlainObject(declaredValue)) {
            const missingMembers: Record<string, unknown> = {};
            for (const [member, memberRequirement] of Object.entries(requirement)) {
                if (memberRequirement !== undefined && declaredValue[member] === undefined) {
                    missingMembers[member] = memberRequirement;
                }
            }
            if (Object.keys(missingMembers).length > 0) {
                missing[capability] = missingMembers;
            }
        }
    }

    return Object.keys(missing).length > 0 ? (missing as ClientCapabilities) : undefined;
}
