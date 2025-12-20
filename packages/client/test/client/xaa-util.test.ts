import { getAccessToken, type XAAOptions } from '../../src/client/xaa-util.js';
import type { FetchLike } from '@modelcontextprotocol/core';
import { MockedFunction } from 'vitest';

// Mock fetch function
const mockFetch = vi.fn() as MockedFunction<FetchLike>;

// Helper function to mock metadata discovery
const mockMetadataDiscovery = (url: string) => {
    mockFetch.mockResolvedValueOnce(
        new Response(
            JSON.stringify({
                issuer: url,
                authorization_endpoint: `${url}/authorize`,
                token_endpoint: `${url}/token`,
                response_types_supported: ['code']
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        )
    );
};

describe('XAA Util', () => {
    let xaaOptions: XAAOptions;

    beforeEach(() => {
        mockFetch.mockReset();

        xaaOptions = {
            idpUrl: 'https://idp.example.com',
            mcpResourceUrl: 'https://resource.example.com',
            mcpAuthorisationServerUrl: 'https://auth.example.com',
            idToken: 'test-id-token',
            idpClientId: 'idp-client-id',
            idpClientSecret: 'idp-client-secret',
            mcpClientId: 'mcp-client-id',
            mcpClientSecret: 'mcp-client-secret',
            scope: ['read', 'write']
        };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('getAccessToken', () => {
        describe('successful token exchange flow', () => {
            it('should successfully exchange tokens and return access token', async () => {
                // Mock IDP metadata discovery
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            issuer: 'https://idp.example.com',
                            authorization_endpoint: 'https://idp.example.com/authorize',
                            token_endpoint: 'https://idp.example.com/token',
                            response_types_supported: ['code']
                        }),
                        {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    )
                );

                // Mock first token exchange response (authorization grant)
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A',
                            expires_in: 3600
                        }),
                        {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    )
                );

                // Mock MCP metadata discovery
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code']
                        }),
                        {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    )
                );

                // Mock second token exchange response (access token)
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer',
                            expires_in: 3600
                        }),
                        {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
                expect(mockFetch).toHaveBeenCalledTimes(4);

                // Verify first call is IDP metadata discovery
                const firstCall = mockFetch.mock.calls[0]!;
                expect(firstCall[0].toString()).toContain('idp.example.com');

                // Verify second call is authorization grant request
                const secondCall = mockFetch.mock.calls[1]!;
                expect(secondCall[0]).toBe('https://idp.example.com/token');
                expect(secondCall[1]?.method).toBe('POST');
                expect(secondCall[1]?.headers).toEqual({
                    'Content-Type': 'application/x-www-form-urlencoded'
                });

                // Verify third call is MCP metadata discovery
                const thirdCall = mockFetch.mock.calls[2]!;
                expect(thirdCall[0].toString()).toContain('auth.example.com');

                // Verify fourth call is access token request
                const fourthCall = mockFetch.mock.calls[3]!;
                expect(fourthCall[0]).toBe('https://auth.example.com/token');
                expect(fourthCall[1]?.method).toBe('POST');
                expect(fourthCall[1]?.headers).toEqual({
                    'Content-Type': 'application/x-www-form-urlencoded'
                });
            });

            it('should handle scopes passed as array', async () => {
                xaaOptions.scope = ['read', 'write', 'admin'];

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
                expect(mockFetch).toHaveBeenCalledTimes(4);
            });

            it('should handle scopes passed as Set', async () => {
                xaaOptions.scope = ['read', 'write'];

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
            });

            it('should handle optional scope field not provided', async () => {
                delete xaaOptions.scope;

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
                expect(mockFetch).toHaveBeenCalledTimes(4);
            });

            it('should handle response with optional fields', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A',
                            expires_in: 7200,
                            scope: 'read write',
                            refresh_token: 'refresh-token-value'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer',
                            expires_in: 3600,
                            scope: 'read write',
                            refresh_token: 'access-refresh-token'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
            });
        });

        describe('authorization grant request failures', () => {
            it('should throw error when authorization grant request fails with 400', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_request',
                            error_description: 'Invalid token exchange request'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
                expect(mockFetch).toHaveBeenCalledTimes(2);
            });

            it('should throw error when authorization grant request fails with 401', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error when authorization grant request fails with 500', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error when authorization grant request throws network error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockRejectedValueOnce(new Error('Network error'));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error when authorization grant response has invalid error type', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'unknown_error',
                            error_description: 'Unknown error occurred'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
            });

            it('should throw error when authorization grant response has invalid issued_token_type', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'invalid-token-type',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error when authorization grant response has invalid token_type', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error when authorization grant response missing access_token', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
            });
        });

        describe('access token exchange request failures', () => {
            beforeEach(() => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                // Mock successful authorization grant request
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');
            });

            it('should throw error when access token request fails with 400', async () => {
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_grant',
                            error_description: 'Invalid authorization grant'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange authorization grant for access token'
                );
                expect(mockFetch).toHaveBeenCalledTimes(4);
            });

            it('should throw error when access token request fails with 401', async () => {
                mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange authorization grant for access token'
                );
            });

            it('should throw error when access token request fails with 500', async () => {
                mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange authorization grant for access token'
                );
            });

            it('should throw error when access token request throws network error', async () => {
                mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange the authorization grant for access token'
                );
            });

            it('should throw error when access token response has invalid error type', async () => {
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'custom_error',
                            error_description: 'Custom error'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
            });

            it('should throw error when access token response has invalid token_type', async () => {
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Invalid'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange the authorization grant for access token'
                );
            });

            it('should throw error when access token response missing access_token', async () => {
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
            });

            it('should throw error when access token response missing token_type', async () => {
                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token'
                        }),
                        { status: 200 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
            });
        });

        describe('OAuth error handling', () => {
            it('should throw error for invalid_request error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_request',
                            error_description: 'The request is missing a required parameter',
                            error_uri: 'https://tools.ietf.org/html/rfc6749#section-5.2'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for invalid_client error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_client',
                            error_description: 'Client authentication failed'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for invalid_grant error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_grant',
                            error_description: 'The provided authorization grant is invalid'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow(
                    'Failed to exchange authorization grant for access token'
                );
            });

            it('should throw error for unauthorized_client error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'unauthorized_client',
                            error_description: 'The client is not authorized to use this grant type'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for unsupported_grant_type error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'unsupported_grant_type',
                            error_description: 'The grant type is not supported'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for invalid_scope error', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            error: 'invalid_scope',
                            error_description: 'The requested scope is invalid or exceeds the granted scope'
                        }),
                        { status: 400 }
                    )
                );

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });
        });

        describe('edge cases and validation', () => {
            it('should throw error for empty response body', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for malformed JSON response', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(new Response('not valid json', { status: 200 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should throw error for response with unexpected status codes', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(new Response('Accepted', { status: 202 }));

                await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow('Failed to obtain authorization grant');
            });

            it('should correctly construct URLs with trailing slashes', async () => {
                xaaOptions.idpUrl = 'https://idp.example.com/';
                xaaOptions.mcpAuthorisationServerUrl = 'https://auth.example.com/';

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com/');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com/');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
                // Check the token endpoint URL from metadata discovery
                expect(mockFetch.mock.calls[1]![0]).toContain('https://idp.example.com');
                expect(mockFetch.mock.calls[3]![0]).toContain('https://auth.example.com');
            });

            it('should maintain proper request headers for both calls', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                await getAccessToken(xaaOptions, mockFetch);

                // Check token request headers (calls 1 and 3, since 0 and 2 are metadata)
                expect(mockFetch.mock.calls[1]![1]?.headers).toEqual({
                    'Content-Type': 'application/x-www-form-urlencoded'
                });
                expect(mockFetch.mock.calls[3]![1]?.headers).toEqual({
                    'Content-Type': 'application/x-www-form-urlencoded'
                });
            });

            it('should pass client credentials correctly in request body', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                await getAccessToken(xaaOptions, mockFetch);

                // Verify first token request includes IDP credentials (call index 1, since 0 is metadata)
                const firstBody = mockFetch.mock.calls[1]![1]?.body as string;
                expect(firstBody).toContain(`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange`);
                expect(firstBody).toContain(`requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag`);
                expect(firstBody).toContain(`audience=${encodeURIComponent(xaaOptions.mcpAuthorisationServerUrl)}`);
                expect(firstBody).toContain(`scope=${encodeURIComponent(xaaOptions.scope!.join(' '))}`);
                expect(firstBody).toContain(`subject_token=${encodeURIComponent(xaaOptions.idToken)}`);
                expect(firstBody).toContain(`subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token`);
                expect(firstBody).toContain(`client_id=${encodeURIComponent(xaaOptions.idpClientId)}`);
                expect(firstBody).toContain(`client_secret=${encodeURIComponent(xaaOptions.idpClientSecret)}`);

                // Verify second token request includes MCP credentials (call index 3, since 2 is metadata)
                const secondBody = mockFetch.mock.calls[3]![1]?.body as string;
                expect(secondBody).toContain(`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer`);
                expect(secondBody).toContain(`assertion=auth-grant-token`);
                expect(secondBody).toContain(`scope=${encodeURIComponent(xaaOptions.scope!.join(' '))}`);
                expect(secondBody).toContain(`client_id=${encodeURIComponent(xaaOptions.mcpClientId)}`);
                expect(secondBody).toContain(`client_secret=${encodeURIComponent(xaaOptions.mcpClientSecret)}`);
            });
        });

        describe('token type validation', () => {
            it('should accept case-insensitive "N_A" for authorization grant token_type', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'n_a'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
            });

            it('should accept case-insensitive "Bearer" for access token token_type', async () => {
                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
            });

            it('should throw error for invalid issued_token_type values', async () => {
                const invalidTokenTypes = [
                    'urn:ietf:params:oauth:token-type:access_token',
                    'urn:ietf:params:oauth:token-type:jwt',
                    'custom-token-type'
                ];

                for (const invalidType of invalidTokenTypes) {
                    mockFetch.mockReset();
                    // Mock IDP metadata discovery
                    mockMetadataDiscovery('https://idp.example.com');

                    mockFetch.mockResolvedValueOnce(
                        new Response(
                            JSON.stringify({
                                access_token: 'auth-grant-token',
                                issued_token_type: invalidType,
                                token_type: 'N_A'
                            }),
                            { status: 200 }
                        )
                    );

                    await expect(getAccessToken(xaaOptions, mockFetch)).rejects.toThrow();
                }
            });
        });

        describe('request body encoding', () => {
            it('should properly encode special characters in credentials', async () => {
                xaaOptions.idpClientSecret = 'secret@123!#$%^&*()';
                xaaOptions.mcpClientSecret = 'pass+word=special&chars';

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');

                // Check that special characters are properly encoded in the first token request body (call index 1)
                const firstBody = mockFetch.mock.calls[1]![1]?.body as string;
                expect(firstBody).toContain(`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange`);
                expect(firstBody).toContain(`requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag`);
                expect(firstBody).toContain(`audience=${encodeURIComponent(xaaOptions.mcpAuthorisationServerUrl)}`);
                expect(firstBody).toContain(`scope=${encodeURIComponent(xaaOptions.scope!.join(' '))}`);
                expect(firstBody).toContain(`subject_token=${encodeURIComponent(xaaOptions.idToken)}`);
                expect(firstBody).toContain(`subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token`);
                expect(firstBody).toContain(`client_id=${encodeURIComponent(xaaOptions.idpClientId)}`);
                expect(firstBody).toContain(`client_secret=secret%40123%21%23%24%25%5E%26%2A%28%29`);

                // Check that special characters are properly encoded in the second token request body (call index 3)
                const secondBody = mockFetch.mock.calls[3]![1]?.body as string;
                expect(secondBody).toContain(`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer`);
                expect(secondBody).toContain(`assertion=auth-grant-token`);
                expect(secondBody).toContain(`scope=${encodeURIComponent(xaaOptions.scope!.join(' '))}`);
                expect(secondBody).toContain(
                    `client_id=${encodeURIComponent(xaaOptions.mcpClientId)}&` + `client_secret=pass%2Bword%3Dspecial%26chars`
                );
            });

            it('should properly encode scope values', async () => {
                xaaOptions.scope = ['read:user', 'write:data', 'admin:all'];

                // Mock IDP metadata discovery
                mockMetadataDiscovery('https://idp.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'auth-grant-token',
                            issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                            token_type: 'N_A'
                        }),
                        { status: 200 }
                    )
                );

                // Mock MCP metadata discovery
                mockMetadataDiscovery('https://auth.example.com');

                mockFetch.mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            access_token: 'final-access-token',
                            token_type: 'Bearer'
                        }),
                        { status: 200 }
                    )
                );

                const result = await getAccessToken(xaaOptions, mockFetch);

                expect(result).toBe('final-access-token');
            });
        });
    });
});
