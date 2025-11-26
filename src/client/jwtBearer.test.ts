import { describe, it, expect } from 'vitest';
import { createPrivateKeyJwtAuth } from './auth-extensions.js';

describe('createPrivateKeyJwtAuth', () => {
    const baseOptions = {
        issuer: 'client-id',
        subject: 'client-id',
        privateKey: 'a-string-secret-at-least-256-bits-long',
        alg: 'HS256'
    };

    it('creates an addClientAuthentication function that sets JWT assertion params', async () => {
        const addClientAuth = createPrivateKeyJwtAuth(baseOptions);

        const headers = new Headers();
        const params = new URLSearchParams();

        await addClientAuth(headers, params, 'https://auth.example.com/token', undefined);

        expect(params.get('client_assertion')).toBeTruthy();
        expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

        // Verify JWT structure (three dot-separated segments)
        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('creates a signed JWT when using a Uint8Array HMAC key', async () => {
        const secret = new TextEncoder().encode('a-string-secret-at-least-256-bits-long');

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: secret,
            alg: 'HS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('creates a signed JWT when using a symmetric JWK key', async () => {
        const jwk: Record<string, unknown> = {
            kty: 'oct',
            // "a-string-secret-at-least-256-bits-long" base64url-encoded
            k: 'YS1zdHJpbmctc2VjcmV0LWF0LWxlYXN0LTI1Ni1iaXRzLWxvbmc',
            alg: 'HS256'
        };

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: jwk,
            alg: 'HS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('creates a signed JWT when using an RSA PEM private key', async () => {
        // Generate an RSA key pair on the fly
        const jose = await import('jose');
        const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
        const pem = await jose.exportPKCS8(privateKey);

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: pem,
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('uses metadata.issuer as audience when available', async () => {
        const addClientAuth = createPrivateKeyJwtAuth(baseOptions);

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', {
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        });

        const assertion = params.get('client_assertion')!;
        // Decode the payload to verify audience
        const [, payloadB64] = assertion.split('.');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        expect(payload.aud).toBe('https://issuer.example.com');
    });

    it('throws when using an unsupported algorithm', async () => {
        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: 'a-string-secret-at-least-256-bits-long',
            alg: 'none'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            'Unsupported algorithm none'
        );
    });

    it('throws when jose cannot import an invalid RSA PEM key', async () => {
        const badPem = '-----BEGIN PRIVATE KEY-----\nnot-a-valid-key\n-----END PRIVATE KEY-----';

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: badPem,
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            /Invalid character/
        );
    });

    it('throws when jose cannot import a mismatched JWK key', async () => {
        const jwk: Record<string, unknown> = {
            kty: 'oct',
            k: 'c2VjcmV0LWtleQ', // "secret-key" base64url
            alg: 'HS256'
        };

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: jwk,
            // Ask for an RSA algorithm with an octet key, which should cause jose.importJWK to fail
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            /Key for the RS256 algorithm must be one of type CryptoKey, KeyObject, or JSON Web Key/
        );
    });
});
