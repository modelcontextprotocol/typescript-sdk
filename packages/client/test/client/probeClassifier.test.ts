/**
 * Row-by-row tests for the merged probe-outcome classifier table.
 *
 * Each `describe` block names the row of the adjudicated table it covers. The
 * HTTP-shaped fixtures mirror the exact bodies deployed servers emit
 * (`createJsonErrorResponse`: `{"jsonrpc":"2.0","error":{...},"id":null}`); the
 * end-to-end capture of the same shapes from real server transports lives in
 * test/integration/test/client/versionNegotiation.test.ts.
 */
import { SdkError, SdkErrorCode, UnsupportedProtocolVersionError } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import type { ProbeClassifierContext, ProbeOutcome, ProbeVerdict } from '../../src/client/probeClassifier';
import { classifyProbeOutcome } from '../../src/client/probeClassifier';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

const baseContext: ProbeClassifierContext = {
    clientModernVersions: [MODERN],
    requestedVersion: MODERN,
    fallbackAvailable: true,
    environment: 'node',
    transportKind: 'http'
};

function classify(outcome: ProbeOutcome, context: Partial<ProbeClassifierContext> = {}): ProbeVerdict {
    return classifyProbeOutcome(outcome, { ...baseContext, ...context });
}

const discoverResult = (supportedVersions: string[]) => ({
    supportedVersions,
    capabilities: { tools: {} },
    serverInfo: { name: 'fixture-server', version: '1.0.0' }
});

/** The deployed-fleet 400 body for a JSON-RPC error (server streamableHttp `createJsonErrorResponse`). */
const httpErrorBody = (code: number, message: string, data?: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', error: data === undefined ? { code, message } : { code, message, data }, id: null });

describe('row: DiscoverResult with version overlap → modern, select from supportedVersions', () => {
    test('selects the mutual modern version', () => {
        const verdict = classify({ kind: 'result', result: discoverResult([MODERN, '2027-01-01']) });
        expect(verdict).toMatchObject({ kind: 'modern', version: MODERN });
    });

    test('selection follows the client preference order', () => {
        const verdict = classify(
            { kind: 'result', result: discoverResult(['2027-01-01', MODERN]) },
            { clientModernVersions: ['2027-01-01', MODERN] }
        );
        expect(verdict).toMatchObject({ kind: 'modern', version: '2027-01-01' });
    });

    test('carries the parsed DiscoverResult for connection state', () => {
        const verdict = classify({ kind: 'result', result: discoverResult([MODERN]) });
        expect(verdict.kind).toBe('modern');
        if (verdict.kind === 'modern') {
            expect(verdict.discover.capabilities).toEqual({ tools: {} });
            expect(verdict.discover.serverInfo.name).toBe('fixture-server');
        }
    });
});

describe('row: DiscoverResult with NO overlap → initialize on the same connection, else typed error with synthesized data', () => {
    test('fallback possible → legacy (era selection on a dual-era server)', () => {
        const verdict = classify({ kind: 'result', result: discoverResult(['2027-12-31']) });
        expect(verdict).toEqual({ kind: 'legacy' });
    });

    test('fallback impossible → typed UnsupportedProtocolVersionError with synthesized data', () => {
        const verdict = classify({ kind: 'result', result: discoverResult(['2027-12-31']) }, { fallbackAvailable: false });
        expect(verdict.kind).toBe('error');
        if (verdict.kind === 'error') {
            expect(verdict.error).toBeInstanceOf(UnsupportedProtocolVersionError);
            const error = verdict.error as UnsupportedProtocolVersionError;
            expect(error.supported).toEqual(['2027-12-31']);
            expect(error.requested).toBe(MODERN);
        }
    });
});

describe('row: -32022 + valid data.supported with a mutual modern version → select-and-continue, MUST NOT fall back', () => {
    test('in-band -32022 yields a corrective verdict (never legacy)', () => {
        const verdict = classify({
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: [MODERN], requested: '2027-01-01' }
        });
        expect(verdict).toMatchObject({ kind: 'corrective', version: MODERN });
    });

    test('HTTP 400-bodied -32022 yields the same corrective verdict', () => {
        const verdict = classify({
            kind: 'http-error',
            status: 400,
            body: httpErrorBody(-32_022, 'Unsupported protocol version', { supported: [MODERN], requested: MODERN })
        });
        expect(verdict).toMatchObject({ kind: 'corrective', version: MODERN });
    });

    test('corrective even when the mutual version equals the just-rejected one (T2/A6 — caller runs it exactly once)', () => {
        const verdict = classify({
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: [MODERN], requested: MODERN }
        });
        expect(verdict).toMatchObject({ kind: 'corrective', version: MODERN });
        if (verdict.kind === 'corrective') {
            expect(verdict.error).toBeInstanceOf(UnsupportedProtocolVersionError);
        }
    });
});

describe('row: -32022 with a disjoint-but-modern list → typed error, never initialize', () => {
    test('no mutual modern version but the list is modern', () => {
        const verdict = classify({
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: ['2027-12-31'], requested: MODERN }
        });
        expect(verdict.kind).toBe('error');
        if (verdict.kind === 'error') {
            expect(verdict.error).toBeInstanceOf(UnsupportedProtocolVersionError);
            expect((verdict.error as UnsupportedProtocolVersionError).supported).toEqual(['2027-12-31']);
        }
    });
});

describe('row: -32022 with a legacy-only list → initialize; modern-only client → typed error carrying data.supported', () => {
    test('legacy-only list with fallback available → legacy', () => {
        const verdict = classify({
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: [LEGACY, '2025-06-18'] }
        });
        expect(verdict).toEqual({ kind: 'legacy' });
    });

    test('legacy-only list, modern-only client → typed error carrying data.supported', () => {
        const verdict = classify(
            { kind: 'rpc-error', code: -32_022, message: 'Unsupported protocol version', data: { supported: [LEGACY] } },
            { fallbackAvailable: false }
        );
        expect(verdict.kind).toBe('error');
        if (verdict.kind === 'error') {
            expect((verdict.error as UnsupportedProtocolVersionError).supported).toEqual([LEGACY]);
            expect((verdict.error as UnsupportedProtocolVersionError).requested).toBe(MODERN);
        }
    });

    test('-32022 with malformed data (no valid supported list) → conservative legacy', () => {
        expect(classify({ kind: 'rpc-error', code: -32_022, message: 'nope', data: { supported: 'not-a-list' } })).toEqual({
            kind: 'legacy'
        });
        expect(classify({ kind: 'rpc-error', code: -32_022, message: 'nope' })).toEqual({ kind: 'legacy' });
    });
});

describe('row: -32601 → legacy (never modern evidence on the probe, including 200-bodied errors)', () => {
    test('in-band -32601 (stdio / 200-bodied HTTP)', () => {
        expect(classify({ kind: 'rpc-error', code: -32_601, message: 'Method not found' })).toEqual({ kind: 'legacy' });
    });

    test('HTTP 404-bodied -32601', () => {
        expect(classify({ kind: 'http-error', status: 404, body: httpErrorBody(-32_601, 'Method not found') })).toEqual({
            kind: 'legacy'
        });
    });
});

describe('row: 400 + -32000 "Unsupported protocol version" literal (deployed TS-SDK fleet, stateless) → legacy', () => {
    test('the byte-real literal body', () => {
        // Fixture mirrors server/streamableHttp.ts validateProtocolVersion — the
        // Q10-L1 frozen literal, consumed here as a fixture only.
        const body = httpErrorBody(
            -32_000,
            `Bad Request: Unsupported protocol version: ${MODERN} (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)`
        );
        expect(classify({ kind: 'http-error', status: 400, body })).toEqual({ kind: 'legacy' });
    });
});

describe('row: 400 + -32000 free-text (stateful session-required shapes) → legacy', () => {
    test('"Server not initialized" (stateful first contact; session is checked before version)', () => {
        expect(classify({ kind: 'http-error', status: 400, body: httpErrorBody(-32_000, 'Bad Request: Server not initialized') })).toEqual({
            kind: 'legacy'
        });
    });

    test('"Mcp-Session-Id header is required"', () => {
        expect(
            classify({
                kind: 'http-error',
                status: 400,
                body: httpErrorBody(-32_000, 'Bad Request: Mcp-Session-Id header is required')
            })
        ).toEqual({ kind: 'legacy' });
    });

    test('in-band -32000 free-text', () => {
        expect(classify({ kind: 'rpc-error', code: -32_000, message: 'Server not initialized' })).toEqual({ kind: 'legacy' });
    });
});

describe('row: plain-text/unparseable 400, code 0, empty body, 406, any unrecognized shape → legacy (conservative D4)', () => {
    test('plain-text 400', () => {
        expect(classify({ kind: 'http-error', status: 400, body: 'Bad Request' })).toEqual({ kind: 'legacy' });
    });

    test('JSON-RPC error with code 0', () => {
        expect(classify({ kind: 'rpc-error', code: 0, message: 'weird' })).toEqual({ kind: 'legacy' });
        expect(classify({ kind: 'http-error', status: 400, body: httpErrorBody(0, 'weird') })).toEqual({ kind: 'legacy' });
    });

    test('empty body', () => {
        expect(classify({ kind: 'http-error', status: 400, body: '' })).toEqual({ kind: 'legacy' });
        expect(classify({ kind: 'http-error', status: 400 })).toEqual({ kind: 'legacy' });
    });

    test('406 Not Acceptable', () => {
        expect(classify({ kind: 'http-error', status: 406, body: 'Not Acceptable: Client must accept text/event-stream' })).toEqual({
            kind: 'legacy'
        });
    });

    test('unrecognized 200 result shape (era-ambiguous first-request processing)', () => {
        expect(classify({ kind: 'result', result: { ok: true } })).toEqual({ kind: 'legacy' });
    });
});

describe('row: -32001 / -32020 / -32021 are NEVER probe-recognized → fall into unrecognized → legacy', () => {
    test('-32001 (session-404 overload on deployed servers — the SDK-conventional code, never probe evidence)', () => {
        expect(classify({ kind: 'rpc-error', code: -32_001, message: 'Session not found' })).toEqual({ kind: 'legacy' });
        expect(classify({ kind: 'http-error', status: 404, body: httpErrorBody(-32_001, 'Session not found') })).toEqual({
            kind: 'legacy'
        });
    });

    test('-32020 (the spec-assigned HeaderMismatch code is still never probe evidence)', () => {
        expect(classify({ kind: 'rpc-error', code: -32_020, message: 'Header mismatch' })).toEqual({ kind: 'legacy' });
        expect(classify({ kind: 'http-error', status: 400, body: httpErrorBody(-32_020, 'Header mismatch') })).toEqual({
            kind: 'legacy'
        });
    });

    test('-32021 with data is NOT modern evidence', () => {
        expect(classify({ kind: 'rpc-error', code: -32_021, message: 'Capability required', data: { capability: 'sampling' } })).toEqual({
            kind: 'legacy'
        });
    });
});

describe('row: network outage → typed connect error (Node)', () => {
    test('connection refused is never an era verdict', () => {
        const cause = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        const verdict = classify({ kind: 'network-error', error: cause });
        expect(verdict.kind).toBe('error');
        if (verdict.kind === 'error') {
            expect(verdict.error).toBeInstanceOf(SdkError);
            expect((verdict.error as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        }
    });

    test('a Node TypeError (no CORS layer) is still a typed connect error', () => {
        const verdict = classify({ kind: 'network-error', error: new TypeError('fetch failed') }, { environment: 'node' });
        expect(verdict.kind).toBe('error');
    });
});

describe('row: timeout — transport-aware verdict', () => {
    // The specification's backward-compatibility rule for stdio: "any other
    // error, or does not respond within a reasonable timeout: the server is
    // legacy. Fall back to the initialize handshake." The versioning
    // compatibility matrix draws the same line per transport: stdio probe
    // times out → fall back to initialize; on HTTP the legacy signal is a 4xx
    // without a recognized modern error body, so silence stays an outage.
    test('HTTP: timeout maps to the standard RequestTimeout SdkError (silence on a deployed server is an outage)', () => {
        const verdict = classify({ kind: 'timeout', timeoutMs: 60_000 }, { transportKind: 'http' });
        expect(verdict.kind).toBe('error');
        if (verdict.kind === 'error') {
            expect(verdict.error).toBeInstanceOf(SdkError);
            expect((verdict.error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
        }
    });

    test('stdio: timeout is a legacy-server signal → fall back to initialize on the same stream', () => {
        expect(classify({ kind: 'timeout', timeoutMs: 5_000 }, { transportKind: 'stdio' })).toEqual({ kind: 'legacy' });
    });
});

describe('row: browser opaque CORS/preflight TypeError, PROBE PHASE ONLY → legacy fallback (F-7)', () => {
    test('browser environment + bare TypeError → legacy', () => {
        expect(classify({ kind: 'network-error', error: new TypeError('Failed to fetch') }, { environment: 'browser' })).toEqual({
            kind: 'legacy'
        });
    });

    test('cross-realm TypeError (name-based recognition) → legacy in a browser', () => {
        const foreign = new Error('Failed to fetch');
        foreign.name = 'TypeError';
        expect(classify({ kind: 'network-error', error: foreign }, { environment: 'browser' })).toEqual({ kind: 'legacy' });
    });

    test('browser non-TypeError network failure stays a typed connect error', () => {
        const verdict = classify({ kind: 'network-error', error: new Error('socket hang up') }, { environment: 'browser' });
        expect(verdict.kind).toBe('error');
    });
});
