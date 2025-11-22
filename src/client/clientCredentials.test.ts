import { exchangeClientCredentials } from './auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformation } from '../shared/auth.js';

describe('exchangeClientCredentials', () => {
    it('posts client_credentials with client_secret_post and scope/resource', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                access_token: 'cc_token',
                token_type: 'bearer',
                expires_in: 3600
            })
        });

        const metadata: AuthorizationServerMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };

        const clientInformation: OAuthClientInformation = {
            client_id: 'c1',
            client_secret: 's1'
        };

        const tokens = await exchangeClientCredentials('https://auth.example.com', {
            metadata,
            clientInformation,
            scope: 'read write',
            resource: new URL('https://api.example.com/mcp'),
            fetchFn: mockFetch
        });

        expect(tokens.access_token).toBe('cc_token');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(String(url)).toBe('https://auth.example.com/token');
        const body = String((init as RequestInit).body);
        expect(body).toContain('grant_type=client_credentials');
        expect(body).toContain('scope=read+write');
        expect(body).toContain('resource=' + encodeURIComponent('https://api.example.com/mcp'));
        // client_secret_post default when no methods specified by AS
        expect(body).toContain('client_id=c1');
        expect(body).toContain('client_secret=s1');
    });

    it('uses addClientAuthentication for private_key_jwt', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                access_token: 'cc_token',
                token_type: 'bearer',
                expires_in: 3600
            })
        });

        const metadata: AuthorizationServerMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            token_endpoint_auth_methods_supported: ['private_key_jwt'],
            response_types_supported: ['code']
        };

        const clientInformation: OAuthClientInformation = {
            client_id: 'c1'
        };

        const addClientAuthentication = async (_headers: Headers, params: URLSearchParams) => {
            params.set('client_assertion', 'fake.jwt.value');
            params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        };

        await exchangeClientCredentials('https://auth.example.com', {
            metadata,
            clientInformation,
            scope: 'mcp:read',
            addClientAuthentication,
            fetchFn: mockFetch
        });

        const [, init] = mockFetch.mock.calls[0];
        const body = String((init as RequestInit).body);
        expect(body).toContain('grant_type=client_credentials');
        expect(body).toContain('client_assertion=fake.jwt.value');
        expect(body).toContain('client_assertion_type=' + encodeURIComponent('urn:ietf:params:oauth:client-assertion-type:jwt-bearer'));
    });
});
