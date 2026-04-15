import { describe, expect, expectTypeOf, test } from 'vitest';
import type { FetchLike, IsomorphicHeaders, RequestInfo } from '../../src/exports/public/index.js';

describe('v1 compat type aliases (core/public)', () => {
    test('IsomorphicHeaders aliases the standard Headers type', () => {
        expectTypeOf<IsomorphicHeaders>().toEqualTypeOf<Headers>();
        const h: IsomorphicHeaders = new Headers({ 'content-type': 'application/json' });
        expect(h.get('content-type')).toBe('application/json');
    });

    test('RequestInfo aliases the standard Request type', () => {
        expectTypeOf<RequestInfo>().toEqualTypeOf<Request>();
        const r: RequestInfo = new Request('http://localhost/mcp');
        expect(r.url).toBe('http://localhost/mcp');
    });

    test('FetchLike is re-exported', () => {
        const f: FetchLike = (url, init) => fetch(url, init);
        expect(typeof f).toBe('function');
    });
});
