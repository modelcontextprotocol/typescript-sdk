/**
 * RFC 6749 §2.3.1: for `client_secret_basic`, the client identifier and the
 * client password are each encoded before being joined with ":" and
 * base64-encoded into the `Authorization` header. The encoding is the RFC 3986
 * percent-encoding the Python SDK uses (`quote(value, safe="")`), so `~` stays
 * as it is; a form-decoding token endpoint recovers both halves.
 */
import { describe, expect, it } from 'vitest';

import { applyBasicAuth, applyClientAuthentication, exchangeAuthorization } from '../../src/client/auth';

/** What a conformant authorization server recovers from a Basic header. */
function recoverCredentials(authorization: string): { username: string; password: string } {
    const decoded = Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const formDecode = (value: string): string => decodeURIComponent(value.replace(/\+/g, ' '));

    return {
        username: formDecode(decoded.slice(0, separator)),
        password: formDecode(decoded.slice(separator + 1))
    };
}

describe('client_secret_basic credential encoding (RFC 6749 §2.3.1)', () => {
    it('percent-encodes both halves before base64-encoding them', () => {
        const headers = new Headers();
        applyBasicAuth('client id', 'sec:ret+with=special', headers);

        const authorization = headers.get('Authorization');
        expect(authorization).toBeTruthy();

        const decoded = Buffer.from(authorization!.replace(/^Basic /, ''), 'base64').toString('utf8');

        // space -> "%20", ":" -> "%3A", "+" -> "%2B", "=" -> "%3D".
        expect(decoded).toBe('client%20id:sec%3Aret%2Bwith%3Dspecial');
    });

    it('leaves "~" unencoded like the Python SDK', () => {
        const headers = new Headers();
        applyBasicAuth('cid', 'Abc8Q~xYz.-_Q', headers);

        const decoded = Buffer.from(headers.get('Authorization')!.replace(/^Basic /, ''), 'base64').toString('utf8');

        // A form encoder would send "Q%7E"; existing secrets such as Entra's
        // "Q~..." must keep their bytes.
        expect(decoded).toBe('cid:Abc8Q~xYz.-_Q');
        expect(recoverCredentials(headers.get('Authorization')!).password).toBe('Abc8Q~xYz.-_Q');
    });

    it('lets a conformant server recover the original credentials', () => {
        const headers = new Headers();
        applyClientAuthentication('client_secret_basic', { client_id: 'client id', client_secret: 'a+b' }, headers, new URLSearchParams());

        expect(recoverCredentials(headers.get('Authorization')!)).toEqual({
            username: 'client id',
            password: 'a+b'
        });
    });

    it('does not throw on credentials outside Latin-1', () => {
        const headers = new Headers();

        // `btoa` rejects any code point above U+00FF, which aborted the token
        // request before it was sent; form-encoding leaves only ASCII behind.
        expect(() => applyBasicAuth('cid', 'p€ss 中', headers)).not.toThrow();
        expect(recoverCredentials(headers.get('Authorization')!).password).toBe('p€ss 中');
    });

    it('encodes the credentials on the token request itself', async () => {
        const authorizationHeaders: string[] = [];
        const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
            authorizationHeaders.push(new Headers(init?.headers).get('Authorization') ?? '');
            return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };

        await exchangeAuthorization('https://as.example.com', {
            metadata: {
                issuer: 'https://as.example.com',
                authorization_endpoint: 'https://as.example.com/authorize',
                token_endpoint: 'https://as.example.com/token',
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic']
            },
            clientInformation: { client_id: 'client id', client_secret: 'a+b' },
            authorizationCode: 'the-code',
            codeVerifier: 'the-verifier',
            redirectUri: 'https://client.example.com/callback',
            fetchFn
        });

        expect(authorizationHeaders).toHaveLength(1);
        expect(recoverCredentials(authorizationHeaders[0]!)).toEqual({
            username: 'client id',
            password: 'a+b'
        });
    });
});
