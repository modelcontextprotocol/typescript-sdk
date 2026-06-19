/**
 * Inbound HTTP request classification and the inbound validation ladder
 * (protocol revision 2026-07-28).
 *
 * `classifyInboundRequest` is the body-primary era predicate for an HTTP
 * entry that serves both protocol eras on one endpoint. It is evaluated
 * exactly once, at the entry boundary, on the already-parsed request body:
 *
 * - `initialize` is a legacy-era request by definition (the modern era has no
 *   `initialize` handshake) — unless it carries a valid envelope claim naming
 *   a modern revision, in which case the claim wins and the request is
 *   classified like any other enveloped request (the modern era then answers
 *   it with method-not-found, exactly like every other method it does not
 *   define).
 * - A request whose `params._meta` carries the reserved protocol-version key
 *   claims the per-request envelope mechanism and classifies into the era the
 *   named revision belongs to (a malformed envelope behind a present claim is
 *   a validation error, never a silent fall back to legacy handling).
 * - A request without a claim is legacy-era traffic.
 * - The `MCP-Protocol-Version` header is a cross-check only: it never
 *   upgrades or downgrades a body-derived classification, and a disagreement
 *   between header and body is an explicit ladder outcome.
 * - Notifications carry no envelope claim of their own under the current
 *   spec, so for notification POSTs without a body claim the modern header is
 *   determinative; the `Mcp-Method` header is validated against the body when
 *   the message classifies modern and is never enforced on legacy traffic.
 *   A notification that does carry a claim is treated body-primary like a
 *   request, and a malformed claim is rejected the same way a request's
 *   malformed claim is — never silently resolved against the header.
 *   The notification-POST header cross-checks here are an SDK-defensive
 *   posture, not a spec requirement: the spec leaves header rules for posted
 *   notifications undefined (core client notifications do not occur over
 *   Streamable HTTP); applying the request rules symmetrically is what an
 *   ecosystem custom-notification POST expects, and the −32001 cells stay
 *   passing for them.
 * - `GET`/`DELETE` (and any other non-`POST` method) are body-less 2025-era
 *   session operations: the modern era is `POST`-only, so they are routed to
 *   legacy serving when it is configured and rejected otherwise.
 * - Array (batch) bodies are classified element-wise: an array containing a
 *   modern-claiming or invalid element is rejected, an all-legacy array is
 *   legacy traffic unchanged, and a single-element array is still an array.
 *
 * The classifier returns plain values (it never throws and never touches a
 * transport): a routing outcome (`legacy`/`modern`) or a ladder rejection
 * carrying the JSON-RPC error to emit and the HTTP status to emit it with.
 * Legacy routing outcomes deliberately carry NO `MessageClassification` —
 * legacy and hand-wired traffic is never classified, which keeps its
 * dispatch behavior byte-identical to today's.
 *
 * Error codes for the modern-path rejection cells follow the published
 * conformance suite (and the spec text it asserts):
 *
 * - A header/body cross-check mismatch (the `MCP-Protocol-Version` header
 *   disagreeing with the body, or the `Mcp-Method` header disagreeing with the
 *   body method) is rejected with `-32001` (`HeaderMismatch`) on HTTP 400.
 * - A request whose protocol-version header names a modern revision but whose
 *   body carries no `_meta` envelope claim — including an envelope present but
 *   missing the required protocol-version key — is rejected with `-32602`
 *   (invalid params) naming the missing key(s), on HTTP 400.
 *
 * Should a future spec revision or conformance release change these
 * assignments, the affected cells are re-derived against that release; the
 * `settled` flag on {@linkcode InboundLadderRejection} stays available to mark
 * a cell provisional again while such a change is in flight.
 */
import { PROTOCOL_VERSION_META_KEY } from '../types/constants.js';
import { ProtocolErrorCode } from '../types/enums.js';
import { ProtocolError, UnsupportedProtocolVersionError } from '../types/errors.js';
import { isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResultResponse } from '../types/guards.js';
import type { JSONRPCNotification, JSONRPCRequest, MessageClassification } from '../types/types.js';
import { envelopeClaimVersion, hasEnvelopeClaim, requestMetaOf, validateEnvelopeMeta } from './envelope.js';
import { isModernProtocolVersion } from './protocolEras.js';

/* ------------------------------------------------------------------------ *
 * Classifier input
 * ------------------------------------------------------------------------ */

/**
 * The transport-neutral description of an inbound HTTP request the classifier
 * evaluates. The caller (the HTTP entry) reads the body exactly once and
 * extracts the two protocol headers; the classifier never touches a request
 * object itself.
 */
export interface InboundHttpRequest {
    /** The HTTP request method, e.g. `POST`, `GET`, `DELETE`. */
    httpMethod: string;
    /** The value of the `MCP-Protocol-Version` header, when present. */
    protocolVersionHeader?: string;
    /** The value of the `Mcp-Method` header, when present. */
    mcpMethodHeader?: string;
    /** The parsed JSON request body (`undefined` for body-less methods). */
    body?: unknown;
}

/* ------------------------------------------------------------------------ *
 * Classifier outcomes
 * ------------------------------------------------------------------------ */

/** Why an inbound request was routed to legacy-era serving. */
export type InboundLegacyRouteReason =
    /** Non-`POST` HTTP method: a body-less 2025-era session operation. */
    | 'http-method'
    /** An `initialize` request without a valid modern envelope claim — the legacy handshake by definition. */
    | 'initialize'
    /** A request without a per-request envelope claim. */
    | 'no-claim'
    /** A notification without a body claim or a modern protocol-version header. */
    | 'notification'
    /** An all-legacy JSON-RPC batch array. */
    | 'batch'
    /** A JSON-RPC response posted to the endpoint (2025-era session traffic). */
    | 'response';

/**
 * The request is legacy-era traffic. It carries no classification on purpose:
 * legacy serving receives it exactly as a hand-wired 2025 transport would.
 */
export interface InboundLegacyRoute {
    kind: 'legacy';
    reason: InboundLegacyRouteReason;
    /**
     * The protocol version the request named, when it named one (an
     * `initialize` body's `protocolVersion`, or the `MCP-Protocol-Version`
     * header). Used to echo `requested` when legacy serving is not configured.
     */
    requestedVersion?: string;
}

/**
 * The request claims the per-request envelope mechanism and is served on the
 * modern path. Discriminated by `messageKind` so the typed `message` narrows
 * with it — the classifier has already proved the JSON-RPC shape via the
 * `isJSONRPCRequest` / `isJSONRPCNotification` guards, so consumers never
 * cast the body again.
 */
export type InboundModernRoute =
    | {
          kind: 'modern';
          messageKind: 'request';
          /** The classified body — guard-proved {@linkcode JSONRPCRequest} shape. */
          message: JSONRPCRequest;
          /**
           * The classification handed to the per-request transport and validated by
           * the protocol layer against the serving instance's negotiated era.
           */
          classification: MessageClassification;
      }
    | {
          kind: 'modern';
          messageKind: 'notification';
          /** The classified body — guard-proved {@linkcode JSONRPCNotification} shape. */
          message: JSONRPCNotification;
          classification: MessageClassification;
      };

/** The named steps of the inbound validation ladder, in evaluation order. */
export type InboundValidationRung =
    | 'http-method'
    | 'jsonrpc-shape'
    | 'era-classification'
    | 'envelope'
    | 'method-registry'
    | 'request-params'
    | 'client-capabilities'
    | 'param-header-validation';

/** A ladder rejection: the JSON-RPC error to emit and the HTTP status to emit it with. */
export interface InboundLadderRejection {
    kind: 'reject';
    /** The ladder rung that produced the rejection. */
    rung: InboundValidationRung;
    /** The cell this rejection corresponds to on the ladder cell sheet (stable identifier for tests). */
    cell: string;
    /** The HTTP status the rejection is emitted with. */
    httpStatus: number;
    /** The JSON-RPC error code. */
    code: number;
    /** The JSON-RPC error message. */
    message: string;
    /** Structured error data (recognizers parse this; they never rely on class identity). */
    data?: unknown;
    /**
     * `false` when the exact error code for this cell is not settled upstream
     * yet and the emitted code is provisional.
     */
    settled: boolean;
}

/** The outcome of classifying one inbound HTTP request. */
export type InboundClassificationOutcome = InboundLegacyRoute | InboundModernRoute | InboundLadderRejection;

/* ------------------------------------------------------------------------ *
 * Header cross-check mismatches
 * ------------------------------------------------------------------------ */

/**
 * The error code emitted for header/body cross-check mismatches: the
 * `MCP-Protocol-Version` header disagreeing with the body's envelope claim (or
 * with the body's classification), and the `Mcp-Method` header disagreeing
 * with the body method.
 *
 * `-32001` is the draft schema's `HEADER_MISMATCH` constant (the SEP-2243
 * `HeaderMismatch` code; the spec requires HTTP 400 for it), as also asserted
 * by the published conformance suite for header-validation failures. It has no
 * {@linkcode ProtocolErrorCode} member because it is not part of the 2025-era
 * wire vocabulary; the validation ladder is its only emitter.
 */
export const HEADER_MISMATCH_ERROR_CODE = -32_001;

/* ------------------------------------------------------------------------ *
 * The validation ladder as data
 * ------------------------------------------------------------------------ */

/** One rung of the inbound validation ladder. */
export interface InboundValidationRungDescriptor {
    rung: InboundValidationRung;
    /** Evaluation order: lower runs first; an earlier rung's outcome wins over a later rung's. */
    order: number;
    /**
     * Where the rung is evaluated: at the HTTP entry edge by
     * {@linkcode classifyInboundRequest} (`edge`), by the HTTP entry after
     * classification but before dispatch (`pre-dispatch`), or by the protocol
     * layer at dispatch (`dispatch`).
     */
    evaluatedAt: 'edge' | 'pre-dispatch' | 'dispatch';
    /** The JSON-RPC error codes this rung can produce (empty when the rung only routes). */
    codes: readonly number[];
    /** Conformance scenarios that exercise this rung (where one exists). */
    conformance: readonly string[];
    /** Why the rung sits where it does. */
    rationale: string;
}

/**
 * The inbound validation ladder, expressed as data rather than control flow.
 *
 * The edge rungs are evaluated by {@linkcode classifyInboundRequest}; the
 * dispatch rungs are evaluated by the protocol layer once the classified
 * message is injected into a per-request server instance (the era registry
 * gate, the envelope requiredness check, and per-method params validation).
 * The client-capability rung is evaluated by the HTTP entry itself,
 * pre-dispatch, on the validated envelope the classifier produced — see that
 * rung's rationale for the ordering caveat. The order is the precedence: a
 * request that fails several rungs is answered by the earliest one.
 */
export const INBOUND_VALIDATION_LADDER: readonly InboundValidationRungDescriptor[] = [
    {
        rung: 'http-method',
        order: 1,
        evaluatedAt: 'edge',
        codes: [-32_000],
        conformance: [],
        rationale:
            'The modern era is POST-only; GET/DELETE are body-less 2025-era session operations and are method-routed to legacy ' +
            'serving (405 when legacy serving is not configured), before any body is read.'
    },
    {
        rung: 'jsonrpc-shape',
        order: 2,
        evaluatedAt: 'edge',
        codes: [ProtocolErrorCode.InvalidRequest],
        conformance: ['server-stateless'],
        rationale:
            'The body must be a JSON-RPC request or notification: posted responses and batch arrays containing a modern or ' +
            'invalid element are rejected before classification (element-wise batch rule); all-legacy arrays stay legacy traffic.'
    },
    {
        rung: 'era-classification',
        order: 3,
        evaluatedAt: 'edge',
        codes: [HEADER_MISMATCH_ERROR_CODE, ProtocolErrorCode.UnsupportedProtocolVersion],
        conformance: ['server-stateless', 'http-header-validation', 'http-custom-header-server-validation'],
        rationale:
            'Body-primary era classification with the protocol-version header as a cross-check; a header/body disagreement is rejected ' +
            'with -32001 (HeaderMismatch), and an envelope-less request on a modern-only endpoint is answered with the ' +
            'unsupported-protocol-version error naming the supported revisions.'
    },
    {
        rung: 'envelope',
        order: 4,
        evaluatedAt: 'edge',
        codes: [ProtocolErrorCode.InvalidParams],
        conformance: ['server-stateless'],
        rationale:
            'A present envelope claim with a malformed envelope — and a missing envelope on a request whose protocol-version header ' +
            'names a modern revision — is an invalid-params rejection naming the offending or missing key(s); never a silent fall ' +
            'back to legacy handling. This is the only place an invalid-params rejection maps to HTTP 400.'
    },
    {
        rung: 'method-registry',
        order: 5,
        evaluatedAt: 'dispatch',
        codes: [ProtocolErrorCode.MethodNotFound],
        conformance: ['server-stateless'],
        rationale:
            'Method existence outranks parameter validity: a method absent from the negotiated revision’s registry (or with no ' +
            'handler installed) answers method-not-found before params or capabilities are looked at.'
    },
    {
        rung: 'request-params',
        order: 6,
        evaluatedAt: 'dispatch',
        codes: [ProtocolErrorCode.InvalidParams],
        conformance: [],
        rationale: 'Per-method params validation; emitted in-band by the dispatch layer (HTTP 200), never via the ladder status table.'
    },
    {
        rung: 'client-capabilities',
        order: 7,
        evaluatedAt: 'pre-dispatch',
        codes: [ProtocolErrorCode.MissingRequiredClientCapability],
        conformance: ['server-stateless'],
        rationale:
            'The capability requirement is checked by the HTTP entry, pre-dispatch, against the validated envelope the ' +
            'classifier produced — pinning the spec-mandated HTTP 400 independently of how dispatch- and handler-produced ' +
            'errors are mapped. The documented order (after method resolution and params validation) is preserved observably ' +
            'only while the requirement table is empty: once a served method gains a requirement entry, a request that is ' +
            'missing the capability and would also fail a dispatch rung is answered by this gate first, so the entry must ' +
            'consult the method registry before the gate if the documented precedence is to stay observable.'
    },
    {
        rung: 'param-header-validation',
        order: 8,
        evaluatedAt: 'pre-dispatch',
        codes: [HEADER_MISMATCH_ERROR_CODE],
        conformance: ['http-custom-header-server-validation'],
        rationale:
            'SEP-2243 `Mcp-Param-*` headers are validated against the named tool’s `x-mcp-header` declarations and the body ' +
            '`arguments` after the tool registry is known and before dispatch reaches the handler; a missing/disagreeing/malformed ' +
            'header is rejected 400 / -32001 with the same shape as the standard-header cross-checks. The documented order ' +
            '(after method resolution and params validation) is preserved observably only when the body `arguments` would ' +
            'otherwise validate: the check runs pre-dispatch, so a `tools/call` that fails BOTH this rung and a dispatch-time ' +
            'rung (e.g. order-6 `request-params`, -32602) is answered by this gate first with 400 / -32001, not by the ' +
            'earlier-ordered rung.'
    }
];

/* ------------------------------------------------------------------------ *
 * HTTP status mapping for ladder-originated errors
 * ------------------------------------------------------------------------ */

/**
 * HTTP status for ladder-originated JSON-RPC error codes.
 *
 * Keyed on origin, not on the bare code: this table only applies to errors
 * the ladder (or a pre-handler protocol gate) produced. Errors produced by
 * request handlers — whatever their code — stay in-band on HTTP 200, and are
 * never mapped to an HTTP status by this table; in particular `-32603` and
 * domain-specific codes never become a blanket 500.
 *
 * `-32602` (invalid params) deliberately has NO entry: the only invalid-params
 * rejection that maps to HTTP 400 is the classifier's own envelope rung
 * short-circuit, which carries its HTTP status directly. A dispatch- or
 * handler-produced invalid-params error is always in-band.
 */
export const LADDER_ERROR_HTTP_STATUS: Readonly<Record<number, number>> = {
    [ProtocolErrorCode.ParseError]: 400,
    [ProtocolErrorCode.InvalidRequest]: 400,
    [ProtocolErrorCode.MethodNotFound]: 404,
    [ProtocolErrorCode.UnsupportedProtocolVersion]: 400,
    [ProtocolErrorCode.MissingRequiredClientCapability]: 400,
    [HEADER_MISMATCH_ERROR_CODE]: 400
};

/**
 * The HTTP status to answer a JSON-RPC error with, keyed on the error's
 * origin. `in-band` errors (anything produced by a request handler) are
 * always HTTP 200 — the JSON-RPC error response is the payload, not an HTTP
 * failure. `ladder` errors map through {@linkcode LADDER_ERROR_HTTP_STATUS}.
 */
export function httpStatusForErrorCode(code: number, origin: 'ladder' | 'in-band'): number {
    if (origin === 'in-band') return 200;
    return LADDER_ERROR_HTTP_STATUS[code] ?? 400;
}

/* ------------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------------ */

function rejection(
    rung: InboundValidationRung,
    cell: string,
    httpStatus: number,
    error: ProtocolError,
    settled: boolean
): InboundLadderRejection {
    return {
        kind: 'reject',
        rung,
        cell,
        httpStatus,
        code: error.code,
        message: error.message,
        ...(error.data !== undefined && { data: error.data }),
        settled
    };
}

function crossCheckMismatch(cell: string, header: string, body: string): InboundLadderRejection {
    return rejection(
        'era-classification',
        cell,
        400,
        new ProtocolError(HEADER_MISMATCH_ERROR_CODE, `Bad Request: the request headers and body disagree: ${body}`, {
            mismatch: { header, body }
        }),
        true
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classificationForClaim(claimedVersion: string | undefined): MessageClassification {
    if (claimedVersion === undefined) {
        return { era: 'modern' };
    }
    return { era: isModernProtocolVersion(claimedVersion) ? 'modern' : 'legacy', revision: claimedVersion };
}

/**
 * Whether a request's params carry a per-request envelope claim that is both
 * well-formed and names a modern protocol revision.
 *
 * Used by the `initialize` precedence rule: only such a claim overrides the
 * `initialize` ⇒ legacy-handshake classification — a request carrying a valid
 * modern envelope is a modern request regardless of its method name, and the
 * modern era then answers `initialize` exactly like any other method it does
 * not define (method-not-found). A malformed claim, or one naming a pre-2026
 * revision, keeps the legacy-handshake routing unchanged.
 *
 * Exported on the core internal barrel for the stdio serving entry, which
 * applies the same precedence rule to a connection's opening message; not
 * public API.
 */
export function carriesValidModernEnvelopeClaim(params: unknown): boolean {
    if (!hasEnvelopeClaim(params)) {
        return false;
    }
    const claimedVersion = envelopeClaimVersion(params);
    if (claimedVersion === undefined || !isModernProtocolVersion(claimedVersion)) {
        return false;
    }
    const meta = requestMetaOf(params);
    return meta !== undefined && validateEnvelopeMeta(meta).length === 0;
}

function classifyBatch(body: readonly unknown[]): InboundClassificationOutcome {
    if (body.length === 0) {
        return rejection(
            'jsonrpc-shape',
            'empty-batch',
            400,
            new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Bad Request: empty JSON-RPC batch'),
            true
        );
    }
    for (const element of body) {
        const params = isPlainObject(element) ? element['params'] : undefined;
        if (hasEnvelopeClaim(params)) {
            // Element-wise rule: a single modern element makes the whole array
            // unservable — modern requests are single-message POSTs, and the
            // legacy path must never serve an envelope-claiming element.
            return rejection(
                'jsonrpc-shape',
                'batch-with-modern-element',
                400,
                new ProtocolError(
                    ProtocolErrorCode.InvalidRequest,
                    'Bad Request: JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later'
                ),
                true
            );
        }
        const valid =
            isJSONRPCRequest(element) ||
            isJSONRPCNotification(element) ||
            isJSONRPCResultResponse(element) ||
            isJSONRPCErrorResponse(element);
        if (!valid) {
            return rejection(
                'jsonrpc-shape',
                'batch-with-invalid-element',
                400,
                new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Bad Request: JSON-RPC batch contains an invalid message'),
                true
            );
        }
    }
    // All elements are legacy-era messages: legacy serving takes the array unchanged.
    return { kind: 'legacy', reason: 'batch' };
}

function classifyRequestBody(request: InboundHttpRequest, body: JSONRPCRequest): InboundClassificationOutcome {
    const params = body.params;
    const method = body.method;
    const headerVersion = request.protocolVersionHeader;
    const headerNamesModern = headerVersion !== undefined && isModernProtocolVersion(headerVersion);

    // `initialize` is the legacy handshake by definition — unless the request
    // carries a valid envelope claim naming a modern revision, in which case
    // the claim wins: the request is classified like any other enveloped
    // request and served on the modern path, where the modern registry answers
    // `initialize` as method-not-found like every other method it does not
    // define. A malformed or absent claim, or a claim naming a pre-2026
    // revision, keeps the legacy-handshake classification below.
    if (method === 'initialize' && !carriesValidModernEnvelopeClaim(params)) {
        if (headerNamesModern) {
            return crossCheckMismatch(
                'initialize-with-modern-header',
                headerVersion,
                'an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header'
            );
        }
        const requestedVersion =
            isPlainObject(params) && typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : undefined;
        return { kind: 'legacy', reason: 'initialize', ...(requestedVersion !== undefined && { requestedVersion }) };
    }

    if (hasEnvelopeClaim(params)) {
        // A present claim is validated, never silently ignored: a malformed
        // envelope behind the claim is an invalid-params rejection naming the
        // offending key, not a fall back to legacy handling.
        const meta = requestMetaOf(params);
        const issues = meta === undefined ? [] : validateEnvelopeMeta(meta);
        const firstIssue = issues[0];
        if (firstIssue !== undefined) {
            return rejection(
                'envelope',
                'envelope-invalid',
                400,
                new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Invalid _meta envelope for protocol revision 2026-07-28: ${firstIssue.key}: ${firstIssue.problem}`,
                    { envelope: firstIssue }
                ),
                true
            );
        }

        const claimedVersion = envelopeClaimVersion(params);
        if (headerVersion !== undefined && claimedVersion !== undefined && headerVersion !== claimedVersion) {
            return crossCheckMismatch(
                'header-body-version-mismatch',
                headerVersion,
                `the body envelope names protocol version ${claimedVersion} but the MCP-Protocol-Version header names ${headerVersion}`
            );
        }
        if (request.mcpMethodHeader !== undefined && request.mcpMethodHeader !== method) {
            return crossCheckMismatch(
                'method-header-mismatch',
                request.mcpMethodHeader,
                `the body names method ${method} but the Mcp-Method header names ${request.mcpMethodHeader}`
            );
        }
        return { kind: 'modern', messageKind: 'request', message: body, classification: classificationForClaim(claimedVersion) };
    }

    // No claim: legacy-era traffic — unless the protocol-version header names a
    // modern revision. The modern revisions carry their request metadata in the
    // per-request `_meta` envelope, so a modern-classified request without one
    // is missing required params: it is rejected with invalid params naming the
    // missing key(s), never silently served as legacy traffic and never
    // upgraded from the header alone.
    if (headerNamesModern) {
        const meta = requestMetaOf(params);
        const missingFromEnvelope = validateEnvelopeMeta(meta ?? {})
            .filter(issue => issue.problem === 'missing')
            .map(issue => issue.key);
        const missing = meta === undefined ? ['_meta'] : missingFromEnvelope.length > 0 ? missingFromEnvelope : [PROTOCOL_VERSION_META_KEY];
        return rejection(
            'envelope',
            'modern-header-without-claim',
            400,
            new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Invalid params: the MCP-Protocol-Version header names protocol revision ${headerVersion}, but the request is missing ` +
                    `the required per-request envelope key(s): ${missing.join(', ')}`,
                { envelope: { missing } }
            ),
            true
        );
    }
    return { kind: 'legacy', reason: 'no-claim', ...(headerVersion !== undefined && { requestedVersion: headerVersion }) };
}

function classifyNotificationBody(request: InboundHttpRequest, body: JSONRPCNotification): InboundClassificationOutcome {
    const params = body.params;
    const method = body.method;
    const headerVersion = request.protocolVersionHeader;
    const headerNamesModern = headerVersion !== undefined && isModernProtocolVersion(headerVersion);

    if (hasEnvelopeClaim(params)) {
        // Body-primary even for notifications: a body claim wins over the
        // header, and a disagreement between them is rejected rather than
        // letting either signal silently pick the serving path.
        const claimedVersion = envelopeClaimVersion(params);
        if (claimedVersion === undefined) {
            // The claim key is present but its value is malformed (not a
            // string). Validated exactly like a request claim: an
            // invalid-params rejection naming the offending key — never a
            // silent win against (or loss to) a disagreeing header.
            const meta = requestMetaOf(params);
            const issues = meta === undefined ? [] : validateEnvelopeMeta(meta);
            const claimIssue = issues.find(issue => issue.key === PROTOCOL_VERSION_META_KEY) ?? {
                key: PROTOCOL_VERSION_META_KEY,
                problem: 'expected a protocol version string'
            };
            return rejection(
                'envelope',
                'notification-envelope-invalid',
                400,
                new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Invalid _meta envelope for protocol revision 2026-07-28: ${claimIssue.key}: ${claimIssue.problem}`,
                    { envelope: claimIssue }
                ),
                true
            );
        }
        if (headerVersion !== undefined && headerVersion !== claimedVersion) {
            return crossCheckMismatch(
                'notification-header-body-version-mismatch',
                headerVersion,
                `the notification envelope names protocol version ${claimedVersion} but the MCP-Protocol-Version header names ${headerVersion}`
            );
        }
        const classification = classificationForClaim(claimedVersion);
        if (classification.era === 'modern' && request.mcpMethodHeader !== undefined && request.mcpMethodHeader !== method) {
            return crossCheckMismatch(
                'notification-method-header-mismatch',
                request.mcpMethodHeader,
                `the notification body names method ${method} but the Mcp-Method header names ${request.mcpMethodHeader}`
            );
        }
        return { kind: 'modern', messageKind: 'notification', message: body, classification };
    }

    // Notifications carry no body claim under the current spec, so the
    // protocol-version header is determinative for them: a modern header
    // routes the notification to modern serving; a missing or legacy header
    // keeps it legacy traffic. The Mcp-Method header is validated only when
    // the notification classifies modern — it is never enforced on legacy
    // notifications.
    if (headerNamesModern) {
        if (request.mcpMethodHeader !== undefined && request.mcpMethodHeader !== method) {
            return crossCheckMismatch(
                'notification-method-header-mismatch',
                request.mcpMethodHeader,
                `the notification body names method ${method} but the Mcp-Method header names ${request.mcpMethodHeader}`
            );
        }
        return {
            kind: 'modern',
            messageKind: 'notification',
            message: body,
            classification: { era: 'modern', revision: headerVersion }
        };
    }
    return { kind: 'legacy', reason: 'notification', ...(headerVersion !== undefined && { requestedVersion: headerVersion }) };
}

/**
 * Classifies one inbound HTTP request for dual-era serving.
 *
 * The body-primary predicate, evaluated once at the entry boundary: see the
 * module documentation for the rules. Returns a routing outcome (`legacy` or
 * `modern`) or a ladder rejection; it never throws.
 */
export function classifyInboundRequest(request: InboundHttpRequest): InboundClassificationOutcome {
    if (request.httpMethod.toUpperCase() !== 'POST') {
        // Body-less 2025-era session operations (and any other non-POST
        // method): the modern era is POST-only.
        return { kind: 'legacy', reason: 'http-method' };
    }

    const body = request.body;
    if (Array.isArray(body)) {
        return classifyBatch(body);
    }
    if (isJSONRPCResultResponse(body) || isJSONRPCErrorResponse(body)) {
        // Posted responses are 2025-era session traffic (replies to
        // server-initiated requests over a session); the modern era has no
        // such channel.
        return { kind: 'legacy', reason: 'response' };
    }
    if (isPlainObject(body) && isJSONRPCRequest(body)) {
        return classifyRequestBody(request, body);
    }
    if (isPlainObject(body) && isJSONRPCNotification(body)) {
        return classifyNotificationBody(request, body);
    }
    return rejection(
        'jsonrpc-shape',
        'invalid-json-rpc-body',
        400,
        new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Bad Request: the request body is not a valid JSON-RPC message'),
        true
    );
}

/* ------------------------------------------------------------------------ *
 * Modern-only (strict) mapping of legacy routes
 * ------------------------------------------------------------------------ */

/**
 * The rejection a modern-only endpoint (no legacy serving configured)
 * answers a legacy-classified request with.
 *
 * - Envelope-less requests (including `initialize`) are answered with the
 *   unsupported-protocol-version error carrying the endpoint's supported
 *   versions and echoing the version the request named (when it named one —
 *   `requested` is omitted rather than fabricated when the request named no
 *   version at all), so a legacy client can discover what the endpoint serves
 *   from the error alone.
 * - Posted responses and batch arrays are invalid requests on the modern era.
 * - Non-`POST` methods are not allowed.
 * - Legacy-classified notifications return `undefined`: the caller answers
 *   202 with no body and does not dispatch the notification (accept-and-drop).
 */
export function modernOnlyStrictRejection(
    route: InboundLegacyRoute,
    supportedVersions: readonly string[]
): InboundLadderRejection | undefined {
    switch (route.reason) {
        case 'http-method': {
            return rejection('http-method', 'modern-only-method-not-allowed', 405, new ProtocolError(-32_000, 'Method not allowed.'), true);
        }
        case 'batch': {
            return rejection(
                'jsonrpc-shape',
                'modern-only-batch-not-supported',
                400,
                new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Bad Request: JSON-RPC batches are not supported by this endpoint'),
                true
            );
        }
        case 'response': {
            return rejection(
                'jsonrpc-shape',
                'modern-only-response-post',
                400,
                new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Bad Request: JSON-RPC responses cannot be posted to this endpoint'),
                true
            );
        }
        case 'notification': {
            return undefined;
        }
        case 'initialize':
        case 'no-claim': {
            // `requested` reflects what the request actually named (an
            // initialize body's `protocolVersion` or the protocol-version
            // header); when the request named no version at all the field is
            // omitted rather than fabricated.
            const requested = route.requestedVersion;
            const error =
                requested === undefined
                    ? new ProtocolError(
                          ProtocolErrorCode.UnsupportedProtocolVersion,
                          'Unsupported protocol version: the request did not name a protocol version',
                          { supported: [...supportedVersions] }
                      )
                    : new UnsupportedProtocolVersionError({ supported: [...supportedVersions], requested });
            return rejection('era-classification', 'modern-only-missing-envelope', 400, error, true);
        }
    }
}
