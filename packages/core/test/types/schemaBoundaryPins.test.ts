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
    RequestMetaEnvelopeSchema,
    ResultSchema
} from '../../src/types/index.js';
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

    test('the declared _meta and resultType members are accepted', () => {
        expect(EmptyResultSchema.safeParse({}).success).toBe(true);
        expect(EmptyResultSchema.safeParse({ _meta: { note: 'x' } }).success).toBe(true);
        expect(EmptyResultSchema.safeParse({ resultType: 'complete' }).success).toBe(true);
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
    test('the base ResultSchema declares resultType and passes unknown siblings through', () => {
        const parsed = ResultSchema.parse({ resultType: 'complete', futureField: 'kept' });
        expect(parsed.resultType).toBe('complete');
        expect((parsed as Record<string, unknown>).futureField).toBe('kept');
    });

    test('unknown top-level siblings on a tools/call result survive the parse', () => {
        const parsed = CallToolResultSchema.parse({
            content: [{ type: 'text', text: 'metered' }],
            resultType: 'complete',
            ttlMs: 5
        });
        expect(parsed.content).toEqual([{ type: 'text', text: 'metered' }]);
        expect(parsed.resultType).toBe('complete');
        expect((parsed as Record<string, unknown>).ttlMs).toBe(5);
    });

    test('CallToolResult content defaults to the empty array when absent', () => {
        // A tool result may carry only structuredContent; the parse then supplies
        // content: [] for backwards compatibility. Removing the default would be a
        // consumer-visible change for every result that omits content.
        const parsed = CallToolResultSchema.parse({ structuredContent: { ok: true } });
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
