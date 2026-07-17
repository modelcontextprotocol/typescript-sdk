/**
 * Merged first-contact fixture corpus (T9 probe edges ∪ wire-real shapes)
 * binding the two pure modules of the negotiation path:
 *
 * - the probe-outcome classifier (`classifyProbeOutcome`): the five T9 probe
 *   edges (plain-text 400; JSON-RPC `code: 0`; probe-success-then-no-overlap
 *   → initialize on the SAME connection; legacy servers that 200-process
 *   era-ambiguous first requests; numeric-id collision avoidance via a string
 *   probe id) merged with the wire-real first-contact shapes a deployed 2025
 *   TypeScript server actually answers (the −32000 "Unsupported protocol
 *   version" literal and the 400/−32000 session-required body). Recognition
 *   is a typed allowlist — codes and structured data — never message-text
 *   sniffing.
 * - the server-side opening classification (the era a connection's first
 *   exchange selects) is bound by `packages/server/test/server/serveStdio.test.ts`.
 *
 * Probe RUNTIME (timeout/retry policy and the connect loop) is covered by the
 * negotiation engine suites; this corpus pins classification only, plus the
 * probe wire shape (string id, `server/discover` first, never a real request).
 */
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import type { ProbeClassifierContext, ProbeOutcome, ProbeVerdict } from '../../src/client/probeClassifier';
import { classifyProbeOutcome } from '../../src/client/probeClassifier';

const MODERN = '2026-07-28';

const baseContext: ProbeClassifierContext = {
    clientModernVersions: [MODERN],
    requestedVersion: MODERN,
    fallbackAvailable: true,
    environment: 'node',
    transportKind: 'stdio'
};

/** The byte-exact first-contact literal a deployed 2025 stateless server answers a modern probe with. */
const DEPLOYED_UNSUPPORTED_VERSION_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
        code: -32_000,
        message: `Bad Request: Unsupported protocol version: ${MODERN} (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)`
    }
});

/** The session-required free-text shape a deployed stateful server answers a session-less probe with. */
const DEPLOYED_SESSION_REQUIRED_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_000, message: 'Bad Request: Server not initialized' }
});

/**
 * The exact discover result a go-sdk v1.7.0-pre.3 server answers the probe
 * with (spec PR #3002 final 2026-07-28 shape): `serverInfo` lives in the
 * result `_meta`, the body field is gone.
 */
const GO_V17_DISCOVER_RESULT = {
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'server', version: 'v0.0.1' } },
    ttlMs: 0,
    cacheScope: 'public',
    supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
    capabilities: { logging: {} }
};

interface CorpusRow {
    name: string;
    outcome: ProbeOutcome;
    context?: Partial<ProbeClassifierContext>;
    expected: ProbeVerdict['kind'];
}

const CORPUS: CorpusRow[] = [
    // --- T9 edge 1: plain-text 400 (no JSON-RPC body at all).
    {
        name: 'T9: plain-text HTTP 400 → legacy fallback',
        outcome: { kind: 'http-error', status: 400, body: 'Bad Request' },
        expected: 'legacy'
    },
    // --- T9 edge 2: JSON-RPC error with code 0.
    {
        name: 'T9: JSON-RPC error code 0 → legacy fallback',
        outcome: { kind: 'rpc-error', code: 0, message: 'unknown method' },
        expected: 'legacy'
    },
    // --- T9 edge 3: probe success but no version overlap → initialize on the SAME connection.
    {
        name: 'T9: DiscoverResult with no mutual version + fallback available → legacy (initialize on the same connection)',
        outcome: {
            kind: 'result',
            result: { supportedVersions: ['2027-01-01'], capabilities: {} }
        },
        expected: 'legacy'
    },
    {
        name: 'T9: DiscoverResult with no mutual version + NO fallback (pin / modern-only) → typed error, never initialize',
        outcome: {
            kind: 'result',
            result: { supportedVersions: ['2027-01-01'], capabilities: {} }
        },
        context: { fallbackAvailable: false },
        expected: 'error'
    },
    // --- T9 edge 4: a legacy server that 200-processes an era-ambiguous first request.
    // The probe is server/discover precisely so this comes back as an
    // unrecognized result shape (never a DiscoverResult) and stays legacy.
    {
        name: 'T9: 200-processed era-ambiguous result (not a DiscoverResult) → legacy fallback',
        outcome: { kind: 'result', result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } },
        expected: 'legacy'
    },
    // --- Wire-real shape A: the deployed −32000 unsupported-protocol-version literal (HTTP 400).
    {
        name: 'wire-real: HTTP 400 with the deployed -32000 "Unsupported protocol version" literal → legacy fallback',
        outcome: { kind: 'http-error', status: 400, body: DEPLOYED_UNSUPPORTED_VERSION_BODY },
        expected: 'legacy'
    },
    // --- Wire-real shape B: the deployed 400/−32000 session-required free text.
    {
        name: 'wire-real: HTTP 400 with the deployed -32000 session-required body → legacy fallback',
        outcome: { kind: 'http-error', status: 400, body: DEPLOYED_SESSION_REQUIRED_BODY },
        expected: 'legacy'
    },
    // --- Typed-recognizer allowlist: text never upgrades, codes + structured data decide.
    {
        name: 'recognizer: -32601 whose message merely CONTAINS "Unsupported protocol version" is not modern evidence → legacy',
        outcome: { kind: 'rpc-error', code: -32_601, message: `Unsupported protocol version: ${MODERN}` },
        expected: 'legacy'
    },
    {
        name: 'recognizer: -32022 with a structured supported list naming a mutual modern version → corrective continuation',
        outcome: {
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: [MODERN, LATEST_PROTOCOL_VERSION], requested: '2027-01-01' }
        },
        expected: 'corrective'
    },
    {
        name: 'recognizer: -32022 without a parsable data.supported list is not actionable modern evidence → legacy',
        outcome: { kind: 'rpc-error', code: -32_022, message: 'Unsupported protocol version' },
        expected: 'legacy'
    },
    {
        name: 'recognizer: -32022 with a legacy-only supported list is a definitive legacy signal → legacy',
        outcome: {
            kind: 'rpc-error',
            code: -32_022,
            message: 'Unsupported protocol version',
            data: { supported: [LATEST_PROTOCOL_VERSION], requested: MODERN }
        },
        expected: 'legacy'
    },
    {
        name: 'recognizer: a 200 result that merely mentions supportedVersions in a text field is not a DiscoverResult → legacy',
        outcome: { kind: 'result', result: { content: [{ type: 'text', text: `supportedVersions: ["${MODERN}"]` }] } },
        expected: 'legacy'
    },
    // --- Q12 transport-aware timeout rows (stdio falls back, HTTP stays a typed error).
    {
        name: 'timeout on stdio → legacy fallback (the stdio backward-compatibility rule)',
        outcome: { kind: 'timeout', timeoutMs: 500 },
        expected: 'legacy'
    },
    {
        name: 'timeout on HTTP → typed connect error, never an era verdict',
        outcome: { kind: 'timeout', timeoutMs: 500 },
        context: { transportKind: 'http' },
        expected: 'error'
    },
    // --- -32601 from a deployed legacy server (the common pre-initialize answer).
    {
        name: 'wire-real: -32601 method-not-found → legacy fallback',
        outcome: { kind: 'rpc-error', code: -32_601, message: 'Method not found' },
        expected: 'legacy'
    },
    // --- Wire-real shape C: the #3002 final-revision DiscoverResult (go v1.7.0-pre.3).
    // Regression: before the #3002 alignment the wire schema required body
    // `serverInfo`, so this conforming response failed parse and misclassified
    // legacy — the client then attempted `initialize` against a modern server.
    {
        name: 'wire-real: go v1.7.0-pre.3 DiscoverResult (#3002 shape, serverInfo in _meta) → modern',
        outcome: { kind: 'result', result: GO_V17_DISCOVER_RESULT },
        expected: 'modern'
    },
    // A malformed _meta serverInfo is display-only material and must not
    // demote a conforming DiscoverResult to legacy (receiver leniency: the
    // wire schema drops the bad value instead of failing the parse).
    {
        name: 'recognizer: DiscoverResult with a malformed _meta serverInfo → still modern',
        outcome: {
            kind: 'result',
            result: { ...GO_V17_DISCOVER_RESULT, _meta: { 'io.modelcontextprotocol/serverInfo': 'bogus' } }
        },
        expected: 'modern'
    }
];

describe('T9/T11 merged probe fixture corpus (probe classifier)', () => {
    for (const row of CORPUS) {
        it(row.name, () => {
            const verdict = classifyProbeOutcome(row.outcome, { ...baseContext, ...row.context });
            expect(verdict.kind).toBe(row.expected);
        });
    }

    it('a DiscoverResult with a mutual version is the only result shape that yields a modern verdict', () => {
        const verdict = classifyProbeOutcome(
            {
                kind: 'result',
                result: { supportedVersions: [MODERN], capabilities: {} }
            },
            baseContext
        );
        expect(verdict.kind).toBe('modern');
        if (verdict.kind === 'modern') {
            expect(verdict.version).toBe(MODERN);
        }
    });
});

describe('T9 edge 5: probe wire shape (string probe id on the shared pipe)', () => {
    it('probes with server/discover before any real request, using a string request id and the protocol-version envelope key', async () => {
        const written: JSONRPCMessage[] = [];
        // A scripted silent-legacy transport: records what the client writes and
        // never answers, so only the probe (and, after its timeout, the
        // initialize fallback) ever reaches the wire.
        const transport: Transport = {
            async start() {},
            async close() {},
            async send(message) {
                written.push(message);
            }
        };

        const client = new Client(
            { name: 'probe-shape-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 50 } } }
        );
        // The silent transport also never answers initialize; the connect
        // attempt eventually fails — the probe wire shape is what this pin is
        // about.
        await client.connect(transport, { timeout: 200 }).catch(() => {});

        expect(written.length).toBeGreaterThan(0);
        const probe = written[0] as { id?: unknown; method?: string; params?: { _meta?: Record<string, unknown> } };
        expect(probe.method).toBe('server/discover');
        // String probe id: the probe runs above the Protocol layer on the same
        // shared pipe, so it must never collide with the numeric ids Protocol
        // assigns to real requests.
        expect(typeof probe.id).toBe('string');
        expect(probe.params?._meta?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);
        // Never probe with the first real request: nothing other than the probe
        // and the legacy initialize fallback is written during connect.
        for (const message of written) {
            const method = (message as { method?: string }).method;
            expect(['server/discover', 'initialize', 'notifications/initialized']).toContain(method);
        }
    });
});
