import { allowedMethods } from '../../../../src/server/auth/middleware/allowedMethods.js';

describe('allowedMethods', () => {
    test('returns undefined for allowed HTTP method', () => {
        const req = new Request('http://localhost/test', { method: 'GET' });
        const res = allowedMethods(['GET'], req);
        expect(res).toBeUndefined();
    });

    test('returns 405 response for disallowed HTTP method', async () => {
        const req = new Request('http://localhost/test', { method: 'POST' });
        const res = allowedMethods(['GET'], req);
        expect(res).toBeDefined();
        expect(res!.status).toBe(405);
        expect(res!.headers.get('allow')).toBe('GET');
        expect(await res!.json()).toEqual({
            error: 'method_not_allowed',
            error_description: 'The method POST is not allowed for this endpoint'
        });
    });

    test('supports multiple allowed methods', async () => {
        const req = new Request('http://localhost/test', { method: 'PUT' });
        const res = allowedMethods(['GET', 'POST'], req);
        expect(res).toBeDefined();
        expect(res!.status).toBe(405);
        expect(res!.headers.get('allow')).toBe('GET, POST');
    });
});
