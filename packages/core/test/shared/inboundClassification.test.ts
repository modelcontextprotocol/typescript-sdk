/**
 * Unit tests for the inbound HTTP classifier (`classifyInboundRequest`) and
 * the envelope claim helpers: the body-primary era predicate, claim
 * detection, envelope validation with self-identifying issues, the header
 * cross-checks, notification routing, element-wise batch classification, and
 * the modern-only (strict) rejection mapping.
 *
 * The header/body mismatch cells are pinned to `-32001` (HeaderMismatch) and
 * the missing-envelope / missing-protocol-version cells to `-32602` (invalid
 * params naming the missing key(s)) — the assignments asserted by the
 * published conformance suite.
 */
import { describe, expect, test } from 'vitest';

import { hasEnvelopeClaim, validateEnvelopeMeta } from '../../src/shared/envelope.js';
import type { InboundHttpRequest, InboundLegacyRoute } from '../../src/shared/inboundClassification.js';
import { classifyInboundRequest, modernOnlyStrictRejection } from '../../src/shared/inboundClassification.js';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '../../src/types/constants.js';

const MODERN_REVISION = '2026-07-28';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'classifier-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const modernToolsCall = (meta: Record<string, unknown> = ENVELOPE) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'echo', arguments: {}, _meta: meta }
});

const legacyToolsList = () => ({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

const initializeRequest = (protocolVersion = '2025-06-18') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

const notification = (method = 'notifications/initialized', meta?: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    method,
    ...(meta === undefined ? {} : { params: { _meta: meta } })
});

const post = (body: unknown, headers: { protocolVersion?: string; mcpMethod?: string } = {}): InboundHttpRequest => ({
    httpMethod: 'POST',
    body,
    ...(headers.protocolVersion !== undefined && { protocolVersionHeader: headers.protocolVersion }),
    ...(headers.mcpMethod !== undefined && { mcpMethodHeader: headers.mcpMethod })
});

const expectMismatch = (outcome: ReturnType<typeof classifyInboundRequest>, cell: string) => {
    expect(outcome.kind).toBe('reject');
    if (outcome.kind !== 'reject') return;
    expect(outcome.cell).toBe(cell);
    expect(outcome.rung).toBe('era-classification');
    expect(outcome.httpStatus).toBe(400);
    // Pinned: a header/body disagreement is a header-validation failure and
    // answers -32001 (HeaderMismatch), per the published conformance suite.
    expect(outcome.settled).toBe(true);
    expect(outcome.code).toBe(-32_001);
};

describe('envelope claim detection (claim = the reserved protocol-version key)', () => {
    test('a progress-token-only _meta is not a claim', () => {
        expect(hasEnvelopeClaim({ _meta: { progressToken: 'token-1' } })).toBe(false);
    });

    test('client info / client capabilities alone are not a claim', () => {
        expect(
            hasEnvelopeClaim({
                _meta: { [CLIENT_INFO_META_KEY]: { name: 'c', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} }
            })
        ).toBe(false);
    });

    test('stray reserved-prefix keys are ignored by claim detection', () => {
        expect(hasEnvelopeClaim({ _meta: { 'io.modelcontextprotocol/somethingElse': true } })).toBe(false);
    });

    test('the protocol-version key alone is a claim, even with a non-string value', () => {
        expect(hasEnvelopeClaim({ _meta: { [PROTOCOL_VERSION_META_KEY]: 42 } })).toBe(true);
    });
});

describe('envelope validation issues are self-identifying (key + problem)', () => {
    test('missing required keys are reported in canonical order', () => {
        const issues = validateEnvelopeMeta({ [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION });
        expect(issues.map(issue => issue.key)).toEqual([CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY]);
        expect(issues.every(issue => issue.problem === 'missing')).toBe(true);
    });

    test('a malformed value inside a present key names the key', () => {
        const issues = validateEnvelopeMeta({ ...ENVELOPE, [CLIENT_INFO_META_KEY]: { version: '1.0.0' } });
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]?.key).toContain(CLIENT_INFO_META_KEY);
        expect(issues[0]?.problem).not.toBe('missing');
    });

    test('a complete, well-formed envelope produces no issues', () => {
        expect(validateEnvelopeMeta(ENVELOPE)).toEqual([]);
    });
});

describe('body-primary era predicate', () => {
    test('an envelope-claiming request with a matching header classifies modern', () => {
        const outcome = classifyInboundRequest(post(modernToolsCall(), { protocolVersion: MODERN_REVISION }));
        expect(outcome).toMatchObject({
            kind: 'modern',
            messageKind: 'request',
            classification: { era: 'modern', revision: MODERN_REVISION }
        });
    });

    test('a header-stripped request still classifies modern from the body claim alone', () => {
        // Robustness to proxies/CDNs stripping the MCP-Protocol-Version header:
        // the body claim is primary.
        const outcome = classifyInboundRequest(post(modernToolsCall()));
        expect(outcome).toMatchObject({
            kind: 'modern',
            messageKind: 'request',
            classification: { era: 'modern', revision: MODERN_REVISION }
        });
    });

    test('a claim-less request is legacy traffic and carries no classification', () => {
        const outcome = classifyInboundRequest(post(legacyToolsList(), { protocolVersion: '2025-06-18' }));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'no-claim', requestedVersion: '2025-06-18' });
        expect('classification' in outcome).toBe(false);
    });

    test('initialize is the legacy handshake by definition', () => {
        const outcome = classifyInboundRequest(post(initializeRequest('2025-03-26')));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'initialize', requestedVersion: '2025-03-26' });
    });

    test('an initialize carrying a valid modern envelope claim classifies modern (the claim wins over the handshake rule)', () => {
        // Body-primary: no headers at all, the valid claim alone decides. The
        // modern path then answers `initialize` as method-not-found, exactly
        // like every other method the modern revision does not define.
        const body = { jsonrpc: '2.0', id: 7, method: 'initialize', params: { _meta: ENVELOPE } };
        expect(classifyInboundRequest(post(body))).toMatchObject({
            kind: 'modern',
            messageKind: 'request',
            classification: { era: 'modern', revision: MODERN_REVISION }
        });

        // The same request with conformant standard headers (the wire shape a
        // modern client actually sends) classifies the same way.
        const withHeaders = classifyInboundRequest(post(body, { protocolVersion: MODERN_REVISION, mcpMethod: 'initialize' }));
        expect(withHeaders).toMatchObject({ kind: 'modern', classification: { era: 'modern', revision: MODERN_REVISION } });
    });

    test('an initialize with a malformed envelope claim keeps the legacy-handshake classification', () => {
        const body = {
            jsonrpc: '2.0',
            id: 7,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION } }
        };
        expect(classifyInboundRequest(post(body))).toMatchObject({ kind: 'legacy', reason: 'initialize', requestedVersion: '2025-06-18' });
    });

    test('an initialize whose valid envelope claim names a pre-2026 revision keeps the legacy-handshake classification', () => {
        const meta = { ...ENVELOPE, [PROTOCOL_VERSION_META_KEY]: '2025-06-18' };
        const body = { jsonrpc: '2.0', id: 7, method: 'initialize', params: { _meta: meta } };
        expect(classifyInboundRequest(post(body))).toMatchObject({ kind: 'legacy', reason: 'initialize' });
    });

    test('GET and DELETE are method-routed legacy session operations', () => {
        expect(classifyInboundRequest({ httpMethod: 'GET' })).toMatchObject({ kind: 'legacy', reason: 'http-method' });
        expect(classifyInboundRequest({ httpMethod: 'DELETE' })).toMatchObject({ kind: 'legacy', reason: 'http-method' });
    });

    test('a claim naming a legacy revision keeps the named revision on the classification', () => {
        // The envelope mechanism naming a pre-2026 revision is carried as-is;
        // the serving instance answers it through the protocol-version
        // mismatch handoff rather than being silently re-routed.
        const meta = { ...ENVELOPE, [PROTOCOL_VERSION_META_KEY]: '2025-06-18' };
        const outcome = classifyInboundRequest(post(modernToolsCall(meta)));
        expect(outcome).toMatchObject({ kind: 'modern', classification: { era: 'legacy', revision: '2025-06-18' } });
    });

    test('a claim with a malformed envelope is rejected, never silently treated as legacy', () => {
        const meta = { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION };
        const outcome = classifyInboundRequest(post(modernToolsCall(meta)));
        expect(outcome).toMatchObject({
            kind: 'reject',
            rung: 'envelope',
            cell: 'envelope-invalid',
            httpStatus: 400,
            code: -32_602,
            settled: true,
            data: { envelope: { key: CLIENT_INFO_META_KEY, problem: 'missing' } }
        });
    });

    test('a claim with malformed client capabilities names the offending key', () => {
        const meta = { ...ENVELOPE, [CLIENT_CAPABILITIES_META_KEY]: { sampling: 'yes' } };
        const outcome = classifyInboundRequest(post(modernToolsCall(meta)));
        expect(outcome.kind).toBe('reject');
        if (outcome.kind !== 'reject') return;
        expect(outcome.code).toBe(-32_602);
        const data = outcome.data as { envelope: { key: string } };
        expect(data.envelope.key).toContain(CLIENT_CAPABILITIES_META_KEY);
    });
});

describe('header cross-checks (-32001 HeaderMismatch) and the missing-envelope rejection (-32602)', () => {
    test('a body claim disagreeing with the protocol-version header is a mismatch outcome', () => {
        const outcome = classifyInboundRequest(post(modernToolsCall(), { protocolVersion: '2025-06-18' }));
        expectMismatch(outcome, 'header-body-version-mismatch');
    });

    test('a modern header on a claim-less body is rejected with invalid params naming the missing _meta envelope', () => {
        // Never an upgrade and never a silent legacy fallthrough: the modern
        // revisions require the per-request envelope, so the request is
        // answered as missing required params.
        const outcome = classifyInboundRequest(post(legacyToolsList(), { protocolVersion: MODERN_REVISION }));
        expect(outcome).toMatchObject({
            kind: 'reject',
            rung: 'envelope',
            cell: 'modern-header-without-claim',
            httpStatus: 400,
            code: -32_602,
            settled: true,
            data: { envelope: { missing: ['_meta'] } }
        });
    });

    test('a modern header on a body whose _meta lacks the protocol-version key names that key as missing', () => {
        const body = {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/list',
            params: { _meta: { [CLIENT_INFO_META_KEY]: { name: 'c', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: {} } }
        };
        const outcome = classifyInboundRequest(post(body, { protocolVersion: MODERN_REVISION }));
        expect(outcome).toMatchObject({
            kind: 'reject',
            rung: 'envelope',
            cell: 'modern-header-without-claim',
            httpStatus: 400,
            code: -32_602,
            settled: true,
            data: { envelope: { missing: [PROTOCOL_VERSION_META_KEY] } }
        });
        if (outcome.kind !== 'reject') return;
        expect(outcome.message).toContain(PROTOCOL_VERSION_META_KEY);
    });

    test('initialize with a modern protocol-version header is a mismatch outcome', () => {
        const outcome = classifyInboundRequest(post(initializeRequest(), { protocolVersion: MODERN_REVISION }));
        expectMismatch(outcome, 'initialize-with-modern-header');
    });

    test('an enveloped initialize whose claim disagrees with the protocol-version header is still a mismatch outcome', () => {
        // The claim precedence never bypasses the cross-checks: an initialize
        // carrying a valid modern claim is checked against the header exactly
        // like any other enveloped request.
        const body = { jsonrpc: '2.0', id: 7, method: 'initialize', params: { _meta: ENVELOPE } };
        const outcome = classifyInboundRequest(post(body, { protocolVersion: '2025-06-18' }));
        expectMismatch(outcome, 'header-body-version-mismatch');
    });

    test('an Mcp-Method header disagreeing with the body method is a mismatch outcome on modern requests', () => {
        const outcome = classifyInboundRequest(post(modernToolsCall(), { protocolVersion: MODERN_REVISION, mcpMethod: 'tools/list' }));
        expectMismatch(outcome, 'method-header-mismatch');
    });

    test('a matching Mcp-Method header passes', () => {
        const outcome = classifyInboundRequest(post(modernToolsCall(), { protocolVersion: MODERN_REVISION, mcpMethod: 'tools/call' }));
        expect(outcome.kind).toBe('modern');
    });

    test('the Mcp-Method header is never enforced on legacy requests', () => {
        const outcome = classifyInboundRequest(post(legacyToolsList(), { protocolVersion: '2025-06-18', mcpMethod: 'tools/call' }));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'no-claim' });
    });
});

describe('notification routing (header determinative when the body carries no claim)', () => {
    test('a modern protocol-version header routes a claim-less notification to modern serving', () => {
        const outcome = classifyInboundRequest(post(notification(), { protocolVersion: MODERN_REVISION }));
        expect(outcome).toMatchObject({
            kind: 'modern',
            messageKind: 'notification',
            classification: { era: 'modern', revision: MODERN_REVISION }
        });
    });

    test('a header-stripped notification stays legacy traffic', () => {
        const outcome = classifyInboundRequest(post(notification()));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'notification' });
    });

    test('a legacy protocol-version header keeps the notification legacy', () => {
        const outcome = classifyInboundRequest(post(notification(), { protocolVersion: '2025-06-18' }));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'notification', requestedVersion: '2025-06-18' });
    });

    test('the Mcp-Method header is validated on modern notifications', () => {
        const outcome = classifyInboundRequest(
            post(notification('notifications/progress'), { protocolVersion: MODERN_REVISION, mcpMethod: 'notifications/cancelled' })
        );
        expectMismatch(outcome, 'notification-method-header-mismatch');
    });

    test('the Mcp-Method header is never enforced on legacy notifications', () => {
        const outcome = classifyInboundRequest(
            post(notification('notifications/progress'), { protocolVersion: '2025-06-18', mcpMethod: 'notifications/cancelled' })
        );
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'notification' });
    });

    test('a notification body claim wins over the header and a disagreement is rejected', () => {
        const meta = { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION };
        const claimed = classifyInboundRequest(post(notification('notifications/progress', meta)));
        expect(claimed).toMatchObject({ kind: 'modern', classification: { revision: MODERN_REVISION } });

        const conflicting = classifyInboundRequest(post(notification('notifications/progress', meta), { protocolVersion: '2025-06-18' }));
        expectMismatch(conflicting, 'notification-header-body-version-mismatch');
    });

    test('a notification claim with a malformed value is rejected, naming the offending key', () => {
        // Validated exactly like a request claim: invalid params naming the
        // key — never silently losing to (or overriding) a disagreeing header.
        const meta = { [PROTOCOL_VERSION_META_KEY]: 42 };
        const outcome = classifyInboundRequest(post(notification('notifications/progress', meta)));
        expect(outcome).toMatchObject({
            kind: 'reject',
            rung: 'envelope',
            cell: 'notification-envelope-invalid',
            httpStatus: 400,
            code: -32_602,
            settled: true
        });
        if (outcome.kind !== 'reject') return;
        const data = outcome.data as { envelope: { key: string } };
        expect(data.envelope.key).toBe(PROTOCOL_VERSION_META_KEY);
    });

    test('a notification claim with a malformed value is rejected the same way when a legacy header disagrees', () => {
        const meta = { [PROTOCOL_VERSION_META_KEY]: 42 };
        const outcome = classifyInboundRequest(post(notification('notifications/progress', meta), { protocolVersion: '2025-06-18' }));
        expect(outcome).toMatchObject({ kind: 'reject', rung: 'envelope', cell: 'notification-envelope-invalid', code: -32_602 });
    });

    test('a notification with no claim at all keeps header-determinative routing (not envelope-validated)', () => {
        // Only a present claim is validated; claim-less notifications keep the
        // header-determinative routing above unchanged.
        expect(classifyInboundRequest(post(notification(), { protocolVersion: MODERN_REVISION }))).toMatchObject({ kind: 'modern' });
        expect(classifyInboundRequest(post(notification()))).toMatchObject({ kind: 'legacy', reason: 'notification' });
    });
});

describe('element-wise batch classification', () => {
    test('an all-legacy array stays legacy traffic unchanged', () => {
        const outcome = classifyInboundRequest(post([legacyToolsList(), notification()]));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'batch' });
    });

    test('a single-element array is still an array', () => {
        const outcome = classifyInboundRequest(post([legacyToolsList()]));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'batch' });
    });

    test('an array containing a response element stays legacy traffic', () => {
        const outcome = classifyInboundRequest(post([{ jsonrpc: '2.0', id: 9, result: {} }, legacyToolsList()]));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'batch' });
    });

    test('an array containing a modern-claiming element is rejected', () => {
        const outcome = classifyInboundRequest(post([legacyToolsList(), modernToolsCall()]));
        expect(outcome).toMatchObject({ kind: 'reject', cell: 'batch-with-modern-element', code: -32_600, httpStatus: 400, settled: true });
    });

    test('an array containing an invalid element is rejected', () => {
        const outcome = classifyInboundRequest(post([legacyToolsList(), { not: 'json-rpc' }]));
        expect(outcome).toMatchObject({ kind: 'reject', cell: 'batch-with-invalid-element', code: -32_600, httpStatus: 400 });
    });

    test('an empty array is rejected', () => {
        const outcome = classifyInboundRequest(post([]));
        expect(outcome).toMatchObject({ kind: 'reject', cell: 'empty-batch', code: -32_600 });
    });
});

describe('responses and malformed bodies', () => {
    test('a posted result response is legacy session traffic', () => {
        const outcome = classifyInboundRequest(post({ jsonrpc: '2.0', id: 3, result: {} }));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'response' });
    });

    test('a posted error response is legacy session traffic', () => {
        const outcome = classifyInboundRequest(post({ jsonrpc: '2.0', id: 3, error: { code: -32_000, message: 'oops' } }));
        expect(outcome).toMatchObject({ kind: 'legacy', reason: 'response' });
    });

    test('a body that is not a JSON-RPC message is rejected', () => {
        const outcome = classifyInboundRequest(post({ hello: 'world' }));
        expect(outcome).toMatchObject({ kind: 'reject', cell: 'invalid-json-rpc-body', code: -32_600, httpStatus: 400 });
    });

    test('a missing body is rejected', () => {
        const outcome = classifyInboundRequest({ httpMethod: 'POST' });
        expect(outcome).toMatchObject({ kind: 'reject', cell: 'invalid-json-rpc-body', code: -32_600 });
    });
});

describe('modern-only (strict) rejection mapping', () => {
    const SUPPORTED = [MODERN_REVISION];
    const legacyRoute = (body: unknown, headers: { protocolVersion?: string } = {}): InboundLegacyRoute => {
        const outcome = classifyInboundRequest(post(body, headers));
        expect(outcome.kind).toBe('legacy');
        return outcome as InboundLegacyRoute;
    };

    test('an envelope-less request that named no version omits `requested` rather than fabricating one', () => {
        const rejectionOutcome = modernOnlyStrictRejection(legacyRoute(legacyToolsList()), SUPPORTED);
        expect(rejectionOutcome).toMatchObject({
            cell: 'modern-only-missing-envelope',
            httpStatus: 400,
            code: -32_004,
            settled: true,
            data: { supported: SUPPORTED }
        });
        expect((rejectionOutcome?.data as { requested?: unknown })?.requested).toBeUndefined();
        expect(Object.keys(rejectionOutcome?.data as Record<string, unknown>)).not.toContain('requested');
        expect(rejectionOutcome?.message).toContain('Unsupported protocol version');
    });

    test('an envelope-less initialize names the version it requested', () => {
        const rejectionOutcome = modernOnlyStrictRejection(legacyRoute(initializeRequest('2025-06-18')), SUPPORTED);
        expect(rejectionOutcome).toMatchObject({ code: -32_004, data: { supported: SUPPORTED, requested: '2025-06-18' } });
    });

    test('an envelope-less request echoes the protocol-version header it sent', () => {
        const rejectionOutcome = modernOnlyStrictRejection(legacyRoute(legacyToolsList(), { protocolVersion: '2025-03-26' }), SUPPORTED);
        expect(rejectionOutcome).toMatchObject({ code: -32_004, data: { requested: '2025-03-26' } });
    });

    test('batch and response POSTs are invalid requests on a modern-only endpoint', () => {
        expect(modernOnlyStrictRejection(legacyRoute([legacyToolsList()]), SUPPORTED)).toMatchObject({ code: -32_600, httpStatus: 400 });
        expect(modernOnlyStrictRejection(legacyRoute({ jsonrpc: '2.0', id: 1, result: {} }), SUPPORTED)).toMatchObject({
            code: -32_600,
            httpStatus: 400
        });
    });

    test('non-POST methods are not allowed on a modern-only endpoint', () => {
        const route = classifyInboundRequest({ httpMethod: 'GET' }) as InboundLegacyRoute;
        expect(modernOnlyStrictRejection(route, SUPPORTED)).toMatchObject({
            httpStatus: 405,
            code: -32_000,
            message: 'Method not allowed.'
        });
    });

    test('legacy-classified notifications are accepted-and-dropped (no rejection body)', () => {
        const route = classifyInboundRequest(post(notification())) as InboundLegacyRoute;
        expect(modernOnlyStrictRejection(route, SUPPORTED)).toBeUndefined();
    });
});
