/**
 * Client-capability requirements for inbound requests (protocol revision
 * 2026-07-28).
 *
 * The 2026-07-28 revision carries the client's declared capabilities on every
 * request (`io.modelcontextprotocol/clientCapabilities`), and a server MUST
 * NOT rely on capabilities the client did not declare: when processing a
 * request requires an undeclared capability, the server answers
 * `MissingRequiredClientCapabilityError` (`-32021`) with
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
import type { ClientCapabilities } from '../types/types';

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
 * Whether a required nested member counts as declared even though it is not
 * spelled out: a bare `elicitation: {}` declaration (no mode sub-capability at
 * all) is read as form support — the pre-mode (2025) meaning of a bare
 * declaration — so an `elicitation.form` requirement treats it as satisfied.
 * Declaring any mode explicitly (for example `elicitation: { url: {} }`)
 * removes the implication.
 */
function isImpliedCapabilityMember(capability: string, member: string, declaredValue: Record<string, unknown>): boolean {
    return capability === 'elicitation' && member === 'form' && declaredValue['form'] === undefined && declaredValue['url'] === undefined;
}

/**
 * The client capabilities an embedded multi-round-trip input request requires
 * (call site 2 — the outbound input-request leg): a server MUST NOT send an
 * `inputRequests` kind the request's declared client capabilities do not
 * cover. Returns `undefined` for entries whose method is not one of the
 * embedded input-request kinds (those are a server bug handled separately,
 * not a capability question).
 *
 * The requirement is mode-aware where the capability is: URL-mode elicitation
 * requires `elicitation.url`; form-mode (or mode-omitted) elicitation requires
 * `elicitation.form` (modes are sub-capabilities, and a server MUST NOT send a
 * mode the client did not declare); sampling with `tools`/`toolChoice`
 * requires `sampling.tools`. A bare `elicitation: {}` declaration satisfies
 * the form requirement — see {@linkcode missingClientCapabilities}.
 */
export function requiredClientCapabilitiesForInputRequest(entry: {
    method: string;
    params?: Record<string, unknown>;
}): ClientCapabilities | undefined {
    switch (entry.method) {
        case 'elicitation/create': {
            if (entry.params?.['mode'] === 'url') {
                return { elicitation: { url: {} } };
            }
            return { elicitation: { form: {} } };
        }
        case 'sampling/createMessage': {
            const params = entry.params;
            if (params !== undefined && (params['tools'] !== undefined || params['toolChoice'] !== undefined)) {
                return { sampling: { tools: {} } };
            }
            return { sampling: {} };
        }
        case 'roots/list': {
            return { roots: {} };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Computes the subset of `required` client capabilities the client did not
 * declare. Returns `undefined` when every required capability is declared;
 * otherwise returns an object in the `ClientCapabilities` shape containing
 * exactly the missing capabilities (suitable for
 * `data.requiredCapabilities` on the `-32021` error).
 *
 * A capability counts as declared when its top-level key is present on the
 * declared capabilities; when the requirement names nested members (for
 * example `elicitation: { url: {} }`), each named member must also be present
 * under the declared capability. One lenient reading applies: a bare
 * `elicitation: {}` declaration (no mode sub-capability at all) counts as
 * declaring `elicitation.form` — the pre-mode (2025) meaning of a bare
 * declaration. An absent or empty `declared` value means
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
                if (
                    memberRequirement !== undefined &&
                    declaredValue[member] === undefined &&
                    !isImpliedCapabilityMember(capability, member, declaredValue)
                ) {
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
