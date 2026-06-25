/**
 * LC-02: `server/discover` wired into the typed request funnel — the wire
 * shapes landed earlier but were deliberately union-excluded; this pins the
 * widening into ClientRequestSchema / ServerResultSchema / the typed method
 * maps. Per-era AVAILABILITY stays with the wire registries (one source of
 * truth): the 2026-era registry serves the method, the 2025-era registry does
 * not — there is no neutral runtime schema map to keep in sync.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';

import { ClientRequestSchema, DiscoverResultSchema, ServerResultSchema } from '../../src/types/index';
import type { DiscoverResult, RequestMethod, RequestTypeMap, ResultTypeMap } from '../../src/types/index';
import { getRequestSchema, getResultSchema } from '../../src/wire/rev2025-11-25/registry';
import { getRequestSchema2026, getResultSchema2026 } from '../../src/wire/rev2026-07-28/registry';

describe('server/discover typed-funnel wiring (LC-02)', () => {
    test('ClientRequestSchema accepts a server/discover request', () => {
        const parsed = ClientRequestSchema.safeParse({ method: 'server/discover' });
        expect(parsed.success).toBe(true);
    });

    test('ServerResultSchema accepts a discover result', () => {
        const parsed = ServerResultSchema.safeParse({
            supportedVersions: ['2026-07-28'],
            capabilities: {},
            serverInfo: { name: 's', version: '1' }
        });
        expect(parsed.success).toBe(true);
    });

    test('the typed method maps carry server/discover', () => {
        expectTypeOf<'server/discover'>().toExtend<RequestMethod>();
        expectTypeOf<ResultTypeMap['server/discover']>().toEqualTypeOf<DiscoverResult>();
        expectTypeOf<RequestTypeMap['server/discover']>().toMatchObjectType<{ method: 'server/discover' }>();
    });

    test('per-era availability lives in the wire registries: 2026 serves it, 2025 does not', () => {
        expect(getRequestSchema2026('server/discover')).toBeDefined();
        expect(getResultSchema2026('server/discover')).toBeDefined();
        expect(getRequestSchema('server/discover')).toBeUndefined();
        expect(getResultSchema('server/discover')).toBeUndefined();
    });

    test('a discover result round-trips the schema with its advertisement intact', () => {
        const result = DiscoverResultSchema.parse({
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            serverInfo: { name: 'modern-server', version: '2.0.0' },
            instructions: 'use the tools'
        });
        expect(result.supportedVersions).toEqual(['2026-07-28']);
        expect(result.instructions).toBe('use the tools');
    });
});
