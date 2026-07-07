/**
 * Behavior-surface pins: the strict/strip/loose line each wire schema draws,
 * plus key-existence checks for result members consumers read by name.
 *
 * The Zod schemas draw a deliberate accept/strip/reject boundary at each layer:
 * JSON-RPC envelopes are strict, empty-result acks are strict, typed request
 * params strip unknown siblings, and typed results pass unknown siblings
 * through to the consumer. An additive protocol revision must not silently
 * move that line — these pins make any move loud. A failing pin here means the
 * change is deliberate: update the pin together with a changeset and a
 * migration-doc entry.
 *
 * See docs/behavior-surface-pins.md for the maintenance protocol.
 */
import { describe, expect, test } from 'vitest';

import {
    CallToolRequestSchema,
    CallToolResultSchema,
    ClientCapabilitiesSchema,
    CompleteResultSchema,
    EmptyResultSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResultResponseSchema,
    ResultSchema
} from '../../src/types/index';
// The per-request envelope is wire-only vocabulary and now lives in the
// 2026-era wire module (Q1 increment 2); its accept/reject line is unchanged.
import {
    ClientCapabilities2026Schema,
    ClientCapabilitiesSchema as Wire2026ClientCapabilitiesSchema,
    ListToolsResultSchema as Wire2026ListToolsResultSchema,
    RequestMetaEnvelopeSchema
} from '../../src/wire/rev2026-07-28/schemas';
import type {
    CallToolResult,
    CompleteResult,
    GetPromptResult,
    InitializeResult,
    ListPromptsResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    ListToolsResult,
    ReadResourceResult,
    ServerCapabilities
} from '../../src/types/index';

/** Extract zod issue codes without depending on zod's generics. */
const issueCodes = (err: unknown): string[] => ((err as { issues?: Array<{ code: string }> }).issues ?? []).map(i => i.code);

describe('JSON-RPC envelope schemas are strict', () => {
    test('a request with an unknown top-level sibling is rejected', () => {
        const parsed = JSONRPCRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'ping', params: {}, extraTop: true });
        expect(parsed.success).toBe(false);
        expect(issueCodes(parsed.error)).toContain('unrecognized_keys');
    });

    test('a notification with an unknown top-level sibling is rejected', () => {
        const parsed = JSONRPCNotificationSchema.safeParse({ jsonrpc: '2.0', method: 'notifications/initialized', extraTop: true });
        expect(parsed.success).toBe(false);
        expect(issueCodes(parsed.error)).toContain('unrecognized_keys');
    });

    test('a result response with an unknown top-level sibling is rejected', () => {
        const parsed = JSONRPCResultResponseSchema.safeParse({ jsonrpc: '2.0', id: 1, result: {}, extraTop: true });
        expect(parsed.success).toBe(false);
        expect(issueCodes(parsed.error)).toContain('unrecognized_keys');
    });

    test('an error response with an unknown top-level sibling is rejected', () => {
        const parsed = JSONRPCErrorResponseSchema.safeParse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32600, message: 'nope' },
            extraTop: true
        });
        expect(parsed.success).toBe(false);
        expect(issueCodes(parsed.error)).toContain('unrecognized_keys');
    });
});

describe('EmptyResultSchema is strict', () => {
    test('an extra non-declared field rejects', () => {
        const parsed = EmptyResultSchema.safeParse({ ok: true });
        expect(parsed.success).toBe(false);
        expect(issueCodes(parsed.error)).toContain('unrecognized_keys');
    });

    test('the declared _meta member is accepted; resultType now rejects (deliberate flip)', () => {
        expect(EmptyResultSchema.safeParse({}).success).toBe(true);
        expect(EmptyResultSchema.safeParse({ _meta: { note: 'x' } }).success).toBe(true);
        // BEHAVIOR MIGRATION (Q1 increment 2, ledgered): `resultType` was cut
        // from the base ResultSchema, so the strict empty-result ack now
        // REJECTS `{resultType}` bodies at the schema level. On the protocol
        // path this is invisible for conforming peers: the era codec consumes
        // (2026) or strips (2025, Q1-SD3 ii) the wire member before any
        // schema validation runs. Changeset: codec-split-wire-break;
        // docs/migration/support-2026-07-28.md "Per-era wire codecs".
        expect(EmptyResultSchema.safeParse({ resultType: 'complete' }).success).toBe(false);
    });
});

describe('typed request params strip unknown siblings', () => {
    test('an unknown sibling next to declared tools/call params is accepted and stripped', () => {
        const parsed = CallToolRequestSchema.parse({
            method: 'tools/call',
            params: { name: 'echo', arguments: {}, future2099: 1 }
        });
        expect(parsed.params.name).toBe('echo');
        expect('future2099' in parsed.params).toBe(false);
    });
});

describe('typed result schemas are loose', () => {
    test('the base ResultSchema no longer declares resultType (the masking surface is gone)', () => {
        // BEHAVIOR MIGRATION (Q1 increment 2, ledgered): the optional
        // `resultType` member that every legacy-leg parse silently accepted
        // is cut. The key still passes the loose parse as a FOREIGN sibling
        // (guards are consumer-side value checks, not wire validators), but
        // no neutral schema declares it; on the protocol path the 2025-era
        // codec strips it on lift (Q1-SD3 ii) and the 2026-era codec consumes
        // it. Changeset: codec-split-wire-break.
        const parsed = ResultSchema.parse({ resultType: 'complete', futureField: 'kept' });
        expect('resultType' in parsed).toBe(true); // loose passthrough, undeclared
        expect((parsed as Record<string, unknown>).futureField).toBe('kept');
        expect(Object.keys(ResultSchema.shape)).toEqual(['_meta']);
    });

    test('unknown top-level siblings on a tools/call result survive the parse', () => {
        const parsed = CallToolResultSchema.parse({
            content: [{ type: 'text', text: 'metered' }],
            resultType: 'complete',
            ttlMs: 5
        });
        expect(parsed.content).toEqual([{ type: 'text', text: 'metered' }]);
        expect((parsed as Record<string, unknown>).resultType).toBe('complete'); // undeclared foreign key, loose passthrough
        expect((parsed as Record<string, unknown>).ttlMs).toBe(5);
    });

    test('CallToolResult tolerates absent content on the wire (defaults to [], v1 parity)', () => {
        // BEHAVIOR MIGRATION (reversal, ledgered): `content.default([])` was
        // removed in the codec split (T6 width-leak root: a task-shaped body
        // parsed as a silent success), then RESTORED for ecosystem parity —
        // real deployments omit `content` alongside `structuredContent`, and
        // v1 tolerated that. The T6 leak stays closed at its actual source:
        // the 2025 wire-seam schema (registry) refuses to default content
        // for another result family's vocabulary (rawResultTypeFirst /
        // typedMapAlignment), and the 2026 era stays strict.
        const parsed = CallToolResultSchema.parse({ structuredContent: { ok: true } });
        expect(parsed.content).toEqual([]);
        expect(parsed.structuredContent).toEqual({ ok: true });
        const explicit = CallToolResultSchema.parse({ content: [], structuredContent: { ok: true } });
        expect(explicit.content).toEqual([]);
    });

    test('CallToolResult preserves isError and sibling members through the parse', () => {
        const parsed = CallToolResultSchema.parse({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true },
            isError: true,
            _meta: { example: 'value' }
        });
        expect(parsed.isError).toBe(true);
        expect(parsed.structuredContent).toEqual({ ok: true });
        expect(parsed._meta).toEqual({ example: 'value' });
        expect(parsed.content).toEqual([{ type: 'text', text: 'ok' }]);
    });
});

describe('completion result boundary', () => {
    test('the completion object is loose: unknown sibling fields are preserved', () => {
        const parsed = CompleteResultSchema.parse({ completion: { values: ['alpha'], extraField: 'kept' } });
        expect(parsed.completion.values).toEqual(['alpha']);
        expect((parsed.completion as Record<string, unknown>).extraField).toBe('kept');
    });

    test('completion.values is capped at 100 entries at the parse boundary', () => {
        // The cap is receiver-side ABI: an SDK client cannot observe more than 100
        // values even from a non-SDK server that sends them.
        const hundred = Array.from({ length: 100 }, (_, i) => `v${i}`);
        expect(CompleteResultSchema.safeParse({ completion: { values: hundred } }).success).toBe(true);

        const overCap = CompleteResultSchema.safeParse({ completion: { values: [...hundred, 'v100'] } });
        expect(overCap.success).toBe(false);
        expect(issueCodes(overCap.error)).toContain('too_big');
    });
});

describe('RequestMetaEnvelopeSchema', () => {
    const validEnvelope = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'pin-client', version: '0.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
    };

    test('requires protocolVersion, clientInfo, and clientCapabilities', () => {
        expect(RequestMetaEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
        for (const key of Object.keys(validEnvelope)) {
            const incomplete: Record<string, unknown> = { ...validEnvelope };
            delete incomplete[key];
            expect(RequestMetaEnvelopeSchema.safeParse(incomplete).success).toBe(false);
        }
    });

    test('is loose: foreign _meta keys pass through', () => {
        const parsed = RequestMetaEnvelopeSchema.parse({ ...validEnvelope, 'com.example/custom': 'kept' });
        expect((parsed as Record<string, unknown>)['com.example/custom']).toBe('kept');
    });

    test('clientCapabilities are validated with the 2026 fork: tasks is not vocabulary on this revision', () => {
        // The envelope composes ClientCapabilities2026Schema (the shared
        // shape minus the deleted `tasks` key), matching the server-side
        // fork wired into DiscoverResultSchema. A tasks-bearing claim is
        // foreign vocabulary: it neither validates as a capability (a
        // malformed value cannot reject the envelope) nor survives the parse.
        const withMalformedTasks = {
            ...validEnvelope,
            'io.modelcontextprotocol/clientCapabilities': { tasks: 'not-an-object' }
        };
        expect(RequestMetaEnvelopeSchema.safeParse(withMalformedTasks).success).toBe(true);

        const parsed = RequestMetaEnvelopeSchema.parse({
            ...validEnvelope,
            'io.modelcontextprotocol/clientCapabilities': { sampling: {}, tasks: { requests: {} } }
        });
        const capabilities = parsed['io.modelcontextprotocol/clientCapabilities'] as Record<string, unknown>;
        expect(capabilities.sampling).toEqual({});
        expect('tasks' in capabilities).toBe(false);
    });

    test('the 2026 client-capabilities fork tracks the shared shape exactly (minus tasks, by reference)', () => {
        // The fork lists its members explicitly (dts-rollup determinism — see
        // rev2026-07-28/schemas.ts); this oracle keeps the explicit list from
        // drifting: same keys as the neutral schema minus `tasks`, and every
        // member is the SAME schema object as the wire module's frozen
        // ClientCapabilitiesSchema, composed by reference. (The wire module is
        // self-contained — it no longer composes from the neutral layer; the
        // by-reference check is against the frozen local copy.)
        const sharedKeys = Object.keys(ClientCapabilitiesSchema.shape).filter(key => key !== 'tasks');
        expect(Object.keys(ClientCapabilities2026Schema.shape)).toEqual(sharedKeys);
        for (const key of sharedKeys) {
            expect(
                (ClientCapabilities2026Schema.shape as Record<string, unknown>)[key],
                `member '${key}' must be composed by reference from the frozen wire shape`
            ).toBe((Wire2026ClientCapabilitiesSchema.shape as Record<string, unknown>)[key]);
        }
    });
});

describe('2026 wire result members', () => {
    test('ttlMs is an integer at the wire boundary (anchor parity: the twin says integer)', () => {
        // Type-level parity is structurally blind to this (TS can only say
        // `number`), so pin it at the runtime boundary.
        const base = { resultType: 'complete', ttlMs: 1500, cacheScope: 'public', tools: [] };
        expect(Wire2026ListToolsResultSchema.safeParse(base).success).toBe(true);
        expect(Wire2026ListToolsResultSchema.safeParse({ ...base, ttlMs: 1500.5 }).success).toBe(false);
    });
});

// ---- Key-existence checks for consumer-read result members ----
//
// Mutual-assignability checks against the spec types cannot catch a rename or
// removal of an OPTIONAL member on a loose result type: the old key is absorbed
// by the catchall index signature and the renamed key is optional, so the
// assignment compiles in both directions. Consumers read the members below by
// name, so each must remain a *declared* key of the SDK type. KnownKeyOf strips
// string/number index signatures so that only declared keys count.
type KnownKeyOf<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

const abiKeys =
    <T>() =>
    <K extends KnownKeyOf<T> & string>(...keys: K[]): K[] =>
        keys;

const sdkKeyExistenceChecks = {
    CallToolResult: abiKeys<CallToolResult>()('content', 'structuredContent', 'isError', '_meta'),
    InitializeResult: abiKeys<InitializeResult>()('protocolVersion', 'capabilities', 'serverInfo', 'instructions'),
    ServerCapabilities: abiKeys<ServerCapabilities>()('experimental', 'completions', 'logging', 'prompts', 'resources', 'tools'),
    ListToolsResult: abiKeys<ListToolsResult>()('tools', 'nextCursor'),
    ListResourcesResult: abiKeys<ListResourcesResult>()('resources', 'nextCursor'),
    ListResourceTemplatesResult: abiKeys<ListResourceTemplatesResult>()('resourceTemplates', 'nextCursor'),
    ListPromptsResult: abiKeys<ListPromptsResult>()('prompts', 'nextCursor'),
    GetPromptResult: abiKeys<GetPromptResult>()('messages'),
    ReadResourceResult: abiKeys<ReadResourceResult>()('contents'),
    CompleteResult: abiKeys<CompleteResult>()('completion')
};

describe('key existence for consumer-read result members', () => {
    test('every consumer-read member remains a declared key of its SDK type', () => {
        // The compile of `sdkKeyExistenceChecks` above IS the assertion: a renamed
        // or removed member fails typecheck. The runtime check guards the table
        // itself against accidental truncation.
        expect(sdkKeyExistenceChecks.CallToolResult).toEqual(['content', 'structuredContent', 'isError', '_meta']);
        for (const keys of Object.values(sdkKeyExistenceChecks)) {
            expect(keys.length).toBeGreaterThan(0);
        }
    });
});
