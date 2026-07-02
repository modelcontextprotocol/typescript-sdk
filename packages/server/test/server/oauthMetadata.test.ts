import type { OAuthMetadata } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import type { AuthMetadataOptions } from '../../src/server/middleware/oauthMetadata';
import {
    buildOAuthProtectedResourceMetadata,
    getOAuthProtectedResourceMetadataUrl,
    oauthMetadataResponse
} from '../../src/server/middleware/oauthMetadata';

const oauthMetadata: OAuthMetadata = {
    issuer: 'https://auth.example.com/',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code']
};

const options: AuthMetadataOptions = {
    oauthMetadata,
    resourceServerUrl: new URL('https://api.example.com/mcp'),
    scopesSupported: ['mcp'],
    resourceName: 'Example Server',
    serviceDocumentationUrl: new URL('https://docs.example.com/')
};

describe('buildOAuthProtectedResourceMetadata', () => {
    it('derives the RFC 9728 document', () => {
        const prm = buildOAuthProtectedResourceMetadata(options);
        expect(prm).toEqual({
            resource: 'https://api.example.com/mcp',
            authorization_servers: ['https://auth.example.com/'],
            scopes_supported: ['mcp'],
            resource_name: 'Example Server',
            resource_documentation: 'https://docs.example.com/'
        });
    });

    it('rejects a non-HTTPS issuer', () => {
        expect(() =>
            buildOAuthProtectedResourceMetadata({ ...options, oauthMetadata: { ...oauthMetadata, issuer: 'http://auth.example.com/' } })
        ).toThrow('Issuer URL must be HTTPS');
    });

    it('exempts localhost and honors the insecure escape hatch', () => {
        expect(() =>
            buildOAuthProtectedResourceMetadata({ ...options, oauthMetadata: { ...oauthMetadata, issuer: 'http://localhost:9000/' } })
        ).not.toThrow();
        expect(() =>
            buildOAuthProtectedResourceMetadata({
                ...options,
                dangerouslyAllowInsecureIssuerUrl: true,
                oauthMetadata: { ...oauthMetadata, issuer: 'http://auth.internal/' }
            })
        ).not.toThrow();
    });

    it('rejects issuer URLs with fragments or query strings', () => {
        expect(() =>
            buildOAuthProtectedResourceMetadata({
                ...options,
                oauthMetadata: { ...oauthMetadata, issuer: 'https://auth.example.com/#frag' }
            })
        ).toThrow('fragment');
        expect(() =>
            buildOAuthProtectedResourceMetadata({
                ...options,
                oauthMetadata: { ...oauthMetadata, issuer: 'https://auth.example.com/?x=1' }
            })
        ).toThrow('query string');
    });
});

describe('getOAuthProtectedResourceMetadataUrl', () => {
    it('is path-aware', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/mcp'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource/mcp'
        );
    });

    it('omits the trailing path for a root resource URL', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource'
        );
    });
});

describe('oauthMetadataResponse', () => {
    it('serves the path-aware PRM document with permissive CORS', async () => {
        const response = oauthMetadataResponse(new Request('https://api.example.com/.well-known/oauth-protected-resource/mcp'), options);
        expect(response?.status).toBe(200);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response?.json()).toMatchObject({
            resource: 'https://api.example.com/mcp',
            authorization_servers: ['https://auth.example.com/']
        });
    });

    it('serves the PRM at the bare well-known path for a root resource URL', () => {
        const rootOptions = { ...options, resourceServerUrl: new URL('https://api.example.com/') };
        const response = oauthMetadataResponse(new Request('https://api.example.com/.well-known/oauth-protected-resource'), rootOptions);
        expect(response?.status).toBe(200);
    });

    it('mirrors the AS metadata document', async () => {
        const response = oauthMetadataResponse(new Request('https://api.example.com/.well-known/oauth-authorization-server'), options);
        expect(response?.status).toBe(200);
        expect(await response?.json()).toMatchObject({ issuer: 'https://auth.example.com/' });
    });

    it('answers 405 with an Allow header and OAuth error body for non-GET methods', async () => {
        const response = oauthMetadataResponse(
            new Request('https://api.example.com/.well-known/oauth-authorization-server', { method: 'POST' }),
            options
        );
        expect(response?.status).toBe(405);
        expect(response?.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
        expect(await response?.json()).toMatchObject({ error: 'method_not_allowed' });
    });

    it('answers CORS preflight with 204 and reflected request headers', () => {
        const response = oauthMetadataResponse(
            new Request('https://api.example.com/.well-known/oauth-authorization-server', {
                method: 'OPTIONS',
                headers: { 'Access-Control-Request-Headers': 'authorization, mcp-protocol-version' }
            }),
            options
        );
        expect(response?.status).toBe(204);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response?.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
        expect(response?.headers.get('Access-Control-Allow-Headers')).toBe('authorization, mcp-protocol-version');
    });

    it('returns undefined for unmatched paths so the host falls through', () => {
        expect(oauthMetadataResponse(new Request('https://api.example.com/mcp'), options)).toBeUndefined();
        expect(oauthMetadataResponse(new Request('https://api.example.com/.well-known/other'), options)).toBeUndefined();
    });
});

describe('review-hardened contracts', () => {
    const badIssuer = { ...options, oauthMetadata: { ...oauthMetadata, issuer: 'http://auth.internal/' } };

    it('never throws for unmatched paths, even with a misconfigured issuer', () => {
        expect(oauthMetadataResponse(new Request('https://api.example.com/mcp'), badIssuer)).toBeUndefined();
    });

    it('surfaces the issuer misconfiguration on the discovery routes only', () => {
        expect(() =>
            oauthMetadataResponse(new Request('https://api.example.com/.well-known/oauth-protected-resource/mcp'), badIssuer)
        ).toThrow('Issuer URL must be HTTPS');
    });

    it('tolerates a single trailing slash like path-mounted routers', () => {
        const response = oauthMetadataResponse(new Request('https://api.example.com/.well-known/oauth-protected-resource/mcp/'), options);
        expect(response?.status).toBe(200);
    });

    it('supports HEAD with the same headers and no body', async () => {
        const response = oauthMetadataResponse(
            new Request('https://api.example.com/.well-known/oauth-authorization-server', { method: 'HEAD' }),
            options
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(await response?.text()).toBe('');
    });

    it('marks the reflected preflight allow-list as varying', () => {
        const response = oauthMetadataResponse(
            new Request('https://api.example.com/.well-known/oauth-protected-resource/mcp', {
                method: 'OPTIONS',
                headers: { 'Access-Control-Request-Headers': 'authorization' }
            }),
            options
        );
        expect(response?.headers.get('Vary')).toBe('Access-Control-Request-Headers');
    });
});
