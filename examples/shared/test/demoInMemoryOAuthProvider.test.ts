import type { OAuthClientInformationFull } from '@modelcontextprotocol/core';
import type { AuthorizationParams } from '@modelcontextprotocol/server';
import { InvalidRequestError } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';

import { DemoInMemoryAuthProvider } from '../src/demoInMemoryOAuthProvider.js';

describe('DemoInMemoryAuthProvider', () => {
    let provider: DemoInMemoryAuthProvider;

    beforeEach(() => {
        provider = new DemoInMemoryAuthProvider();
    });

    describe('authorize', () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['https://example.com/callback', 'https://example.com/callback2'],
            scope: 'test-scope'
        };

        it('redirects to redirect_uri when valid', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            const res = await provider.authorize(validClient, params);
            expect(res.status).toBe(302);
            const location = res.headers.get('location');
            expect(location).toBeTruthy();
            const url = new URL(location!);
            expect(url.origin + url.pathname).toBe('https://example.com/callback');
            expect(url.searchParams.get('state')).toBe('test-state');
            expect(url.searchParams.get('code')).toBeTruthy();
            expect(res.headers.get('set-cookie')).toContain('demo_session=');
        });

        it('throws InvalidRequestError for unregistered redirect_uri', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://evil.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await expect(provider.authorize(validClient, params)).rejects.toThrow(InvalidRequestError);
            await expect(provider.authorize(validClient, params)).rejects.toThrow('Unregistered redirect_uri');
        });
    });
});
