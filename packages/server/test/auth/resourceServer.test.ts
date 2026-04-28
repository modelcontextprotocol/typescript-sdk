import { describe, expect, it } from 'vitest';

import {
    buildProtectedResourceMetadata,
    buildWwwAuthenticateHeader,
    checkIssuerUrl,
    getOAuthProtectedResourceMetadataUrl
} from '../../src/auth/resourceServer.js';

describe('buildWwwAuthenticateHeader', () => {
    it('builds a minimal challenge', () => {
        expect(buildWwwAuthenticateHeader('invalid_token', 'nope', [], undefined)).toBe(
            'Bearer error="invalid_token", error_description="nope"'
        );
    });

    it('includes scope and resource_metadata when provided', () => {
        expect(buildWwwAuthenticateHeader('insufficient_scope', 'need more', ['read', 'write'], 'https://rs.example/.well-known/x')).toBe(
            'Bearer error="insufficient_scope", error_description="need more", scope="read write", resource_metadata="https://rs.example/.well-known/x"'
        );
    });
});

describe('checkIssuerUrl', () => {
    it('accepts https issuers', () => {
        expect(() => checkIssuerUrl(new URL('https://as.example.com'))).not.toThrow();
    });

    it('accepts localhost over http', () => {
        expect(() => checkIssuerUrl(new URL('http://localhost:8080'))).not.toThrow();
        expect(() => checkIssuerUrl(new URL('http://127.0.0.1:8080'))).not.toThrow();
    });

    it('rejects non-https non-localhost issuers', () => {
        expect(() => checkIssuerUrl(new URL('http://as.example.com'))).toThrow('Issuer URL must be HTTPS');
    });

    it('rejects issuers with a fragment', () => {
        expect(() => checkIssuerUrl(new URL('https://as.example.com/#frag'))).toThrow('must not have a fragment');
    });

    it('rejects issuers with a query string', () => {
        expect(() => checkIssuerUrl(new URL('https://as.example.com/?q=1'))).toThrow('must not have a query string');
    });
});

describe('getOAuthProtectedResourceMetadataUrl', () => {
    it('inserts the well-known prefix ahead of the path', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/mcp'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource/mcp'
        );
    });

    it('handles a root path', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource'
        );
    });
});

describe('buildProtectedResourceMetadata', () => {
    it('derives the PRM document from options', () => {
        const prm = buildProtectedResourceMetadata({
            oauthMetadata: {
                issuer: 'https://as.example.com',
                authorization_endpoint: 'https://as.example.com/auth',
                token_endpoint: 'https://as.example.com/token',
                response_types_supported: ['code']
            },
            resourceServerUrl: new URL('https://api.example.com/mcp'),
            scopesSupported: ['read'],
            resourceName: 'Example MCP'
        });
        expect(prm).toEqual({
            resource: 'https://api.example.com/mcp',
            authorization_servers: ['https://as.example.com'],
            scopes_supported: ['read'],
            resource_name: 'Example MCP',
            resource_documentation: undefined
        });
    });
});
