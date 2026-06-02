import { InvalidGrantError, isTransientOAuthError, OAuthError, ServerError } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { parseErrorResponse } from '../../src/client/auth.js';

describe('parseErrorResponse error-class compatibility', () => {
    it('returns the specific subclass for known OAuth error codes', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe('invalid_grant');
        expect(isTransientOAuthError(error)).toBe(false);
    });

    it('preserves unknown error codes on the base class and classifies them transient', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
        expect(isTransientOAuthError(error)).toBe(true);
    });

    it('falls back to ServerError for unparsable bodies, matching 1.x', async () => {
        const response = new Response('<html>gateway timeout</html>', { status: 502 });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(ServerError);
        expect(isTransientOAuthError(error)).toBe(true);
    });
});
