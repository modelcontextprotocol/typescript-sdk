/**
 * Integrity tests for the generated-schema re-export layer in types.ts.
 *
 * Since types.ts is now a thin wrapper over generated/sdk.schemas.ts, most
 * exported schemas are the *exact same object* as their generated counterparts.
 * A handful are intentionally overridden for SDK-specific behavior.
 *
 * These tests catch:
 *  - Accidental drops from the re-export list (schema becomes undefined)
 *  - Accidental imports of names that should be overridden (override shadowed)
 *  - Override schemas that stop diverging from spec (dead code)
 *
 * For schema *behavior* tests, see types.test.ts.
 * For compile-time type equivalence, see src/types/generated/sdk.schemas.zod.test.ts.
 */

import * as generated from '../src/types/generated/sdk.schemas.js';
import * as sdk from '../src/types/types.js';

/**
 * Schemas that types.ts defines locally, replacing the generated version.
 * Each entry documents *why* — if the reason no longer holds, remove the override.
 */
const OVERRIDDEN_SCHEMAS = {
    CreateMessageResultSchema: 'SDK uses single content block (backwards compat); spec uses array',
    ElicitResultSchema: 'SDK coerces content: null → undefined via z.preprocess',
    ClientResultSchema: 'SDK adds CreateMessageResultWithToolsSchema; uses overridden CreateMessageResult/ElicitResult',
    ServerResultSchema: 'Rebuilt to keep union member identity with other SDK result schemas',
    // JSON-RPC wire schemas: generator emits `Base.extend({ jsonrpc })` which
    // puts `jsonrpc` LAST in parse output. Transports round-trip every message
    // through these schemas, so SDK rebuilds them with `jsonrpc` first.
    JSONRPCRequestSchema: 'SDK preserves jsonrpc-first key ordering in parse output',
    JSONRPCNotificationSchema: 'SDK preserves jsonrpc-first key ordering in parse output',
    JSONRPCResultResponseSchema: 'SDK preserves jsonrpc-first key ordering in parse output',
    JSONRPCErrorResponseSchema: 'SDK preserves jsonrpc-first key ordering in parse output',
    JSONRPCMessageSchema: 'Union of SDK-overridden wire schemas (transitive override)'
} as const;

/**
 * Schemas that exist in generated output but are NOT part of the SDK's public
 * surface — typically internals that types.ts shadows with its own versions
 * (e.g. to inject RELATED_TASK_META_KEY) or spec-only constants.
 */
const INTENTIONALLY_NOT_REEXPORTED = new Set([
    // Protocol version constants — generated file has spec DRAFT version;
    // SDK hand-maintains released versions in types.ts.
    'LATEST_PROTOCOL_VERSION',
    'JSONRPC_VERSION',
    // Spec-shape schemas that types.ts replaces with SDK-extended equivalents.
    'CreateMessageResultWithToolsSchema' // SDK defines its own (different content shape)
]);

describe('types.ts re-export integrity', () => {
    const generatedNames = Object.keys(generated).filter(name => !INTENTIONALLY_NOT_REEXPORTED.has(name));

    describe('pass-through schemas', () => {
        const passThroughNames = generatedNames.filter(name => !(name in OVERRIDDEN_SCHEMAS));

        test.each(passThroughNames)('%s is the same object as generated', name => {
            const sdkExport = (sdk as Record<string, unknown>)[name];
            const genExport = (generated as Record<string, unknown>)[name];

            expect(sdkExport).toBeDefined();
            expect(sdkExport).toBe(genExport);
        });
    });

    describe('overridden schemas', () => {
        test.each(Object.entries(OVERRIDDEN_SCHEMAS))('%s diverges from generated (%s)', (name, _reason) => {
            const sdkExport = (sdk as Record<string, unknown>)[name];
            const genExport = (generated as Record<string, unknown>)[name];

            expect(sdkExport).toBeDefined();
            expect(genExport).toBeDefined();
            // If these become equal, the override is dead code — remove it from types.ts.
            expect(sdkExport).not.toBe(genExport);
        });
    });

    test('override list stays in sync with this test', () => {
        // Every generated schema name should be either passed through or
        // explicitly listed as overridden. If this fails, a new schema was
        // generated that types.ts neither re-exports nor overrides.
        const unaccounted = generatedNames.filter(name => {
            const sdkExport = (sdk as Record<string, unknown>)[name];
            return sdkExport === undefined;
        });
        expect(unaccounted).toEqual([]);
    });
});

describe('SDK override behavior', () => {
    // Spot-checks that the overrides actually do what their docstrings claim.
    // Full coverage lives in types.test.ts — these just guard the divergence.

    test('CreateMessageResultSchema restricts content to single block', () => {
        const single = {
            model: 'test-model',
            role: 'assistant' as const,
            content: { type: 'text' as const, text: 'hello' }
        };
        const array = { ...single, content: [{ type: 'text' as const, text: 'hello' }] };

        // SDK override narrows content to a single SamplingContentSchema block
        expect(sdk.CreateMessageResultSchema.safeParse(single).success).toBe(true);
        expect(sdk.CreateMessageResultSchema.safeParse(array).success).toBe(false);

        // Generated (spec) version accepts both — SamplingMessage.content is a union.
        // The divergence: SDK rejects the array form that spec permits.
        expect(generated.CreateMessageResultSchema.safeParse(array).success).toBe(true);
    });

    test('ElicitResultSchema coerces null content to undefined', () => {
        const withNull = { action: 'decline' as const, content: null };

        const sdkResult = sdk.ElicitResultSchema.safeParse(withNull);
        expect(sdkResult.success).toBe(true);
        if (sdkResult.success) {
            expect(sdkResult.data.content).toBeUndefined();
        }

        // Generated version rejects null — no preprocess step
        expect(generated.ElicitResultSchema.safeParse(withNull).success).toBe(false);
    });

    test('JSONRPCNotificationSchema emits jsonrpc first in parse output', () => {
        const input = { jsonrpc: '2.0' as const, method: 'notifications/initialized' };

        // SDK override: jsonrpc first — JSON.stringify round-trips cleanly.
        const sdkParsed = sdk.JSONRPCNotificationSchema.parse(input);
        expect(Object.keys(sdkParsed)[0]).toBe('jsonrpc');
        expect(JSON.stringify(sdkParsed)).toBe(JSON.stringify(input));

        // Generated version appends jsonrpc via .extend() — key order differs.
        // If this assertion starts failing, the generator was fixed and the
        // override can be removed.
        const genParsed = generated.JSONRPCNotificationSchema.parse(input);
        expect(Object.keys(genParsed)[0]).not.toBe('jsonrpc');
    });
});
