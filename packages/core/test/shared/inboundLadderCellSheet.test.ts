/**
 * The inbound validation-ladder cell sheet.
 *
 * Each row names one ladder cell, whether its outcome is pinned or
 * parameterized, the conformance scenarios that exercise it (where one
 * exists), and the expected outcome. Pinned rows assert exact codes and HTTP
 * statuses; parameterized rows assert the outcome class and that the emitted
 * code is the documented provisional value drawn from the candidate set —
 * those cells are re-derived when a published conformance release settles the
 * disputed assignments (see the note in
 * `test/conformance/expected-failures.yaml`).
 *
 * Cells evaluated at protocol dispatch (the era registry gate, per-method
 * params, capability assertion) are listed for ordering and status mapping
 * only; their end-to-end HTTP assertions live with the per-request server
 * transport tests in the server package.
 */
import { describe, expect, test } from 'vitest';

import type { InboundHttpRequest, InboundLadderRejection } from '../../src/shared/inboundClassification.js';
import {
    classifyInboundRequest,
    httpStatusForErrorCode,
    INBOUND_VALIDATION_LADDER,
    LADDER_ERROR_HTTP_STATUS,
    modernOnlyStrictRejection,
    PROVISIONAL_CROSS_CHECK_MISMATCH_CODE
} from '../../src/shared/inboundClassification.js';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '../../src/types/constants.js';

const MODERN_REVISION = '2026-07-28';
const MISMATCH_CODE_CANDIDATES = [-32_001, -32_602, -32_004];

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'cell-sheet-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const enveloped = (method: string, params: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: ENVELOPE }
});
const bare = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
const post = (body: unknown, headers: { protocolVersion?: string; mcpMethod?: string } = {}): InboundHttpRequest => ({
    httpMethod: 'POST',
    body,
    ...(headers.protocolVersion !== undefined && { protocolVersionHeader: headers.protocolVersion }),
    ...(headers.mcpMethod !== undefined && { mcpMethodHeader: headers.mcpMethod })
});

interface SheetRow {
    /** Stable cell identifier (matches `InboundLadderRejection.cell` for rejection cells). */
    cell: string;
    /** Pinned cells assert exact outcomes; parameterized cells assert the provisional outcome + candidate-set membership. */
    status: 'pinned' | 'parameterized';
    /** Conformance scenarios exercising the cell, where one exists in the published referee. */
    conformance: readonly string[];
    /** The classifier input. */
    input: InboundHttpRequest;
    /** Strict (modern-only) mapping applies: the legacy route is mapped through `modernOnlyStrictRejection`. */
    strict?: boolean;
    /** The expected outcome for routing cells. */
    route?: 'legacy' | 'modern';
    /** The expected rejection (exact for pinned cells; for parameterized cells `code` is the provisional value). */
    reject?: Partial<InboundLadderRejection>;
    /** Why the cell behaves the way it does. */
    rationale: string;
}

const SHEET: readonly SheetRow[] = [
    /* --- Routing cells (pinned) --------------------------------------------------- */
    {
        cell: 'modern-enveloped-request',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post(enveloped('tools/call', { name: 'echo', arguments: {} }), { protocolVersion: MODERN_REVISION }),
        route: 'modern',
        rationale: 'A request carrying the per-request envelope claim is modern-era traffic.'
    },
    {
        cell: 'modern-enveloped-request-header-stripped',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post(enveloped('tools/call', { name: 'echo', arguments: {} })),
        route: 'modern',
        rationale: 'Body-primary classification: a proxy stripping the protocol-version header must not change the era.'
    },
    {
        cell: 'legacy-claimless-request',
        status: 'pinned',
        conformance: [],
        input: post(bare('tools/list'), { protocolVersion: '2025-06-18' }),
        route: 'legacy',
        rationale: 'A request without an envelope claim is legacy traffic and is never classified.'
    },
    {
        cell: 'legacy-initialize',
        status: 'pinned',
        conformance: [],
        input: post(bare('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })),
        route: 'legacy',
        rationale: 'initialize is the legacy handshake by definition; the modern era has no initialize.'
    },
    {
        cell: 'modern-enveloped-initialize',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post(enveloped('initialize'), { protocolVersion: MODERN_REVISION, mcpMethod: 'initialize' }),
        route: 'modern',
        rationale:
            'A valid modern envelope claim wins over the initialize ⇒ legacy-handshake rule: the request is served on the modern path, ' +
            'where the modern registry answers initialize as method-not-found (-32601, HTTP 404 via the ladder status table) like every ' +
            'other method the revision does not define.'
    },
    {
        cell: 'legacy-method-routed-get',
        status: 'pinned',
        conformance: [],
        input: { httpMethod: 'GET' },
        route: 'legacy',
        rationale: 'GET/DELETE are body-less 2025-era session operations; the modern era is POST-only.'
    },
    {
        cell: 'legacy-notification-stripped-header',
        status: 'pinned',
        conformance: [],
        input: post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        route: 'legacy',
        rationale:
            'A notification without a body claim or a modern header stays legacy traffic (dual mode routes it; strict mode accepts and drops it).'
    },
    {
        cell: 'modern-notification-by-header',
        status: 'pinned',
        conformance: ['http-header-validation'],
        input: post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { protocolVersion: MODERN_REVISION }),
        route: 'modern',
        rationale: 'Notifications carry no body claim, so the modern protocol-version header is determinative for them.'
    },
    {
        cell: 'legacy-batch',
        status: 'pinned',
        conformance: [],
        input: post([bare('tools/list')]),
        route: 'legacy',
        rationale: 'All-legacy arrays go to legacy serving unchanged; a single-element array is still an array.'
    },
    {
        cell: 'legacy-response-post',
        status: 'pinned',
        conformance: [],
        input: post({ jsonrpc: '2.0', id: 5, result: {} }),
        route: 'legacy',
        rationale: 'Posted responses are 2025-era session traffic (replies to server-initiated requests).'
    },

    /* --- Edge rejection cells (pinned) -------------------------------------------- */
    {
        cell: 'envelope-invalid',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION } } }),
        reject: { rung: 'envelope', httpStatus: 400, code: -32_602, settled: true },
        rationale: 'A present claim with a malformed envelope is invalid params naming the key — never a silent legacy fallthrough.'
    },
    {
        cell: 'batch-with-modern-element',
        status: 'pinned',
        conformance: [],
        input: post([bare('tools/list'), enveloped('tools/call', { name: 'echo', arguments: {} })]),
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale: 'Element-wise batch rule: one modern element makes the array unservable on either path.'
    },
    {
        cell: 'batch-with-invalid-element',
        status: 'pinned',
        conformance: [],
        input: post([bare('tools/list'), { nonsense: true }]),
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale: 'Element-wise batch rule: invalid elements are rejected rather than partially served.'
    },
    {
        cell: 'invalid-json-rpc-body',
        status: 'pinned',
        conformance: [],
        input: post({ hello: 'world' }),
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale:
            'A POST body that is not a JSON-RPC message is an invalid request (-32600, the JSON-RPC-correct code). Deliberate ' +
            'divergence from the deployed 2025-era transport, which answers -32700 for the same parsed body; enumerated and ' +
            'exercised on both legs in the era-parity suite (server package).'
    },
    {
        cell: 'empty-batch',
        status: 'pinned',
        conformance: [],
        input: post([]),
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale:
            'An empty JSON-RPC batch is an invalid request at the modern edge. Deliberate divergence from the deployed 2025-era ' +
            'transport, which accepts an empty array as containing only notifications (202, no body); enumerated and exercised on ' +
            'both legs in the era-parity suite (server package).'
    },
    {
        cell: 'notification-envelope-invalid',
        status: 'pinned',
        conformance: [],
        input: post({ jsonrpc: '2.0', method: 'notifications/progress', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 42 } } }),
        reject: { rung: 'envelope', httpStatus: 400, code: -32_602, settled: true },
        rationale:
            'A notification claim with a malformed protocol-version value is invalid params naming the key — exactly like the ' +
            'request path, never a silent win against (or loss to) a disagreeing header.'
    },

    /* --- Modern-only (strict) cells (pinned) --------------------------------------- */
    {
        cell: 'modern-only-missing-envelope',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post(bare('tools/list')),
        strict: true,
        reject: { rung: 'era-classification', httpStatus: 400, code: -32_004, settled: true },
        rationale:
            'A modern-only endpoint answers envelope-less requests with the unsupported-protocol-version error and its supported list. ' +
            'This cell shares its numeric code with the disputed mismatch family but is itself settled.'
    },
    {
        cell: 'modern-only-missing-envelope-initialize',
        status: 'pinned',
        conformance: ['server-stateless'],
        input: post(bare('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })),
        strict: true,
        reject: {
            rung: 'era-classification',
            httpStatus: 400,
            code: -32_004,
            settled: true,
            data: { supported: [MODERN_REVISION], requested: '2025-06-18' }
        },
        rationale:
            'An envelope-less initialize on a modern-only endpoint is answered with the version error naming both sides — the ' +
            'unsupported-protocol-version rejection with the supported list stays reserved for envelope-less requests.'
    },
    {
        cell: 'modern-only-method-not-allowed',
        status: 'pinned',
        conformance: [],
        input: { httpMethod: 'DELETE' },
        strict: true,
        reject: { rung: 'http-method', httpStatus: 405, code: -32_000, settled: true },
        rationale: 'Without legacy serving configured there is nothing to route GET/DELETE to.'
    },
    {
        cell: 'modern-only-batch-not-supported',
        status: 'pinned',
        conformance: [],
        input: post([bare('tools/list')]),
        strict: true,
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale: 'Batches are not part of the modern wire shape.'
    },
    {
        cell: 'modern-only-response-post',
        status: 'pinned',
        conformance: [],
        input: post({ jsonrpc: '2.0', id: 5, result: {} }),
        strict: true,
        reject: { rung: 'jsonrpc-shape', httpStatus: 400, code: -32_600, settled: true },
        rationale: 'There is no server-to-client request channel on the modern era, so posted responses are invalid requests.'
    },

    /* --- Parameterized cells (disputed error-code assignments) --------------------- */
    {
        cell: 'header-body-version-mismatch',
        status: 'parameterized',
        conformance: ['http-header-validation', 'http-custom-header-server-validation'],
        input: post(enveloped('tools/call', { name: 'echo', arguments: {} }), { protocolVersion: '2025-06-18' }),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale: 'Header/body protocol-version disagreement; the exact code is still under discussion upstream.'
    },
    {
        cell: 'modern-header-without-claim',
        status: 'parameterized',
        conformance: ['http-header-validation'],
        input: post(bare('tools/list'), { protocolVersion: MODERN_REVISION }),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale: 'A modern header on a claim-less body is a disagreement, not an upgrade; code pending upstream settlement.'
    },
    {
        cell: 'initialize-with-modern-header',
        status: 'parameterized',
        conformance: ['http-header-validation'],
        input: post(bare('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } }), {
            protocolVersion: MODERN_REVISION
        }),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale: 'An envelope-less initialize classifies legacy; a modern header on it is the same disagreement family.'
    },
    {
        cell: 'method-header-mismatch',
        status: 'parameterized',
        conformance: ['http-custom-header-server-validation'],
        input: post(enveloped('tools/call', { name: 'echo', arguments: {} }), {
            protocolVersion: MODERN_REVISION,
            mcpMethod: 'tools/list'
        }),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale: 'The Mcp-Method header must describe the body it accompanies; the rejection code is pending upstream settlement.'
    },
    {
        cell: 'notification-header-body-version-mismatch',
        status: 'parameterized',
        conformance: [],
        input: post(
            { jsonrpc: '2.0', method: 'notifications/progress', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION } } },
            { protocolVersion: '2025-06-18' }
        ),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale:
            'A notification body claim disagreeing with the protocol-version header is the same disagreement family as the request ' +
            'cells above; the exact code is still under discussion upstream.'
    },
    {
        cell: 'notification-method-header-mismatch',
        status: 'parameterized',
        conformance: [],
        input: post(
            { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } },
            { protocolVersion: MODERN_REVISION, mcpMethod: 'notifications/cancelled' }
        ),
        reject: { rung: 'era-classification', httpStatus: 400, settled: false },
        rationale:
            'The Mcp-Method header must describe the notification body it accompanies (validated only when the notification ' +
            'classifies modern); the rejection code is pending upstream settlement.'
    },
    {
        cell: 'multi-fault-mismatched-claim-and-malformed-envelope',
        status: 'parameterized',
        conformance: ['server-stateless', 'http-header-validation'],
        // The claim names a different version than the header AND the envelope
        // is missing required keys: today the envelope rung answers (the
        // mismatch is only checked on a valid envelope), so the emitted code is
        // -32602 — but the precedence between the era-classification and
        // envelope rungs for multi-fault requests is part of the disputed set.
        input: post(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION } } },
            {
                protocolVersion: '2025-06-18'
            }
        ),
        reject: { httpStatus: 400 },
        rationale:
            'Multi-fault precedence between the version error and invalid params is not settled upstream; asserted as candidate-set membership only.'
    }
];

describe('inbound validation-ladder cell sheet', () => {
    const SUPPORTED = [MODERN_REVISION];

    test.each(SHEET)('$cell', row => {
        let outcome = classifyInboundRequest(row.input);
        if (row.strict) {
            expect(outcome.kind).toBe('legacy');
            if (outcome.kind !== 'legacy') return;
            const mapped = modernOnlyStrictRejection(outcome, SUPPORTED);
            expect(mapped).toBeDefined();
            outcome = mapped!;
        }

        if (row.route !== undefined) {
            expect(outcome.kind).toBe(row.route);
            if (row.route === 'legacy') {
                // Legacy routes never carry a classification (hand-wired and
                // legacy traffic is never classified).
                expect('classification' in outcome).toBe(false);
            }
            return;
        }

        expect(outcome.kind).toBe('reject');
        if (outcome.kind !== 'reject') return;

        if (row.status === 'pinned') {
            expect(outcome).toMatchObject(row.reject ?? {});
        } else {
            // Parameterized: outcome class and provisional code only — the
            // exact assignment is re-derived from a future conformance pin.
            if (row.reject?.rung !== undefined) expect(outcome.rung).toBe(row.reject.rung);
            if (row.reject?.httpStatus !== undefined) expect(outcome.httpStatus).toBe(row.reject.httpStatus);
            expect(MISMATCH_CODE_CANDIDATES).toContain(outcome.code);
            if (row.reject?.settled !== undefined) {
                expect(outcome.settled).toBe(row.reject.settled);
                expect(outcome.code).toBe(PROVISIONAL_CROSS_CHECK_MISMATCH_CODE);
            }
        }
    });

    test('every cell id is unique and every parameterized cell is marked unsettled or candidate-bound', () => {
        const ids = SHEET.map(row => row.cell);
        expect(new Set(ids).size).toBe(ids.length);
        for (const row of SHEET.filter(candidate => candidate.status === 'parameterized')) {
            expect(row.reject).toBeDefined();
        }
    });
});

describe('the validation ladder as data', () => {
    test('rungs are uniquely named and strictly ordered', () => {
        const orders = INBOUND_VALIDATION_LADDER.map(rung => rung.order);
        expect(orders.toSorted((a, b) => a - b)).toEqual(orders);
        expect(new Set(orders).size).toBe(orders.length);
        expect(new Set(INBOUND_VALIDATION_LADDER.map(rung => rung.rung)).size).toBe(INBOUND_VALIDATION_LADDER.length);
    });

    test('the edge rungs precede the dispatch rungs', () => {
        const lastEdge = Math.max(...INBOUND_VALIDATION_LADDER.filter(rung => rung.evaluatedAt === 'edge').map(rung => rung.order));
        const firstDispatch = Math.min(
            ...INBOUND_VALIDATION_LADDER.filter(rung => rung.evaluatedAt === 'dispatch').map(rung => rung.order)
        );
        expect(lastEdge).toBeLessThan(firstDispatch);
    });

    test('method existence outranks parameter validity in the rung order', () => {
        const methodRegistry = INBOUND_VALIDATION_LADDER.find(rung => rung.rung === 'method-registry');
        const requestParams = INBOUND_VALIDATION_LADDER.find(rung => rung.rung === 'request-params');
        expect(methodRegistry!.order).toBeLessThan(requestParams!.order);
    });
});

describe('HTTP status mapping for ladder-originated errors (origin-keyed)', () => {
    test('the table maps exactly the ladder-originated codes', () => {
        // The parse-error and invalid-request rows joined the table when the
        // status matrix was completed alongside the cache fill / capability
        // gate work; they were previously carried only by the classifier's own
        // httpStatus on the rejection outcomes (same 400, now table-visible).
        expect(LADDER_ERROR_HTTP_STATUS).toEqual({
            [-32_700]: 400,
            [-32_601]: 404,
            [-32_600]: 400,
            [-32_004]: 400,
            [-32_003]: 400,
            [-32_001]: 400
        });
    });

    test('the table never maps invalid params: the classifier envelope short-circuit is the only -32602 -> 400 source', () => {
        expect(Object.keys(LADDER_ERROR_HTTP_STATUS)).not.toContain(String(-32_602));
        expect(httpStatusForErrorCode(-32_602, 'in-band')).toBe(200);
    });

    test('handler-originated errors stay in-band on HTTP 200, whatever their code', () => {
        for (const code of [-32_603, -32_602, -32_601, -32_004, -32_002, -32_000, 1234]) {
            expect(httpStatusForErrorCode(code, 'in-band')).toBe(200);
        }
    });

    test('ladder-originated codes map to their HTTP statuses', () => {
        expect(httpStatusForErrorCode(-32_601, 'ladder')).toBe(404);
        expect(httpStatusForErrorCode(-32_004, 'ladder')).toBe(400);
        expect(httpStatusForErrorCode(-32_003, 'ladder')).toBe(400);
        expect(httpStatusForErrorCode(-32_001, 'ladder')).toBe(400);
    });
});
