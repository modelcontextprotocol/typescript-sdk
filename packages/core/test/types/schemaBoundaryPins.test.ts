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
    CompleteResultSchema,
    EmptyResultSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResultResponseSchema,
    ResultSchema
} from '../../src/types/index.js';
// The per-request envelope is wire-only vocabulary and now lives in the
// 2026-era wire module (Q1 increment 2); its accept/reject line is unchanged.
import { RequestMetaEnvelopeSchema } from '../../src/wire/rev2026-07-28/schemas.js';
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
} from '../../src/types/index.js';

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
        // docs/migration.md "Wire schemas no longer model resultType".
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

    test('CallToolResult requires content on the wire (the silent-empty-success default is gone)', () => {
        // BEHAVIOR MIGRATION (Q1 increment 2, ledgered): `content.default([])`
        // was removed from the wire schema. The default was the T6 width-leak
        // root: a task-shaped (or otherwise content-less) body parsed as a
        // silent `{content: []}` success. Content is required by the spec in
        // every revision; a content-less body now fails the parse LOUDLY.
        // Changeset: codec-split-wire-break; docs/migration.md
        // "tools/call results must include content".
        expect(CallToolResultSchema.safeParse({ structuredContent: { ok: true } }).success).toBe(false);
        const parsed = CallToolResultSchema.parse({ content: [], structuredContent: { ok: true } });
        expect(parsed.content).toEqual([]);
        expect(parsed.structuredContent).toEqual({ ok: true });
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
