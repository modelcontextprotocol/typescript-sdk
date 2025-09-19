import { withOAuth, withLogging, applyMiddlewares, createMiddleware } from './middleware.js';
import { OAuthClientProvider } from './auth.js';
import { FetchLike } from '../shared/transport.js';

jest.mock('../client/auth.js', () => {
    const actual = jest.requireActual('../client/auth.js');
    return {
        ...actual,
        auth: jest.fn(),
        extractResourceMetadataUrl: jest.fn()
    };
});

import { auth, extractResourceMetadataUrl } from './auth.js';

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockExtractResourceMetadataUrl = extractResourceMetadataUrl as jest.MockedFunction<typeof extractResourceMetadataUrl>;

describe('withOAuth', () => {
    let mockProvider: jest.Mocked<OAuthClientProvider>;
    let mockFetch: jest.MockedFunction<FetchLike>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockProvider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            tokens: jest.fn(),
            saveTokens: jest.fn(),
            clientInformation: jest.fn(),
            redirectToAuthorization: jest.fn(),
            saveCodeVerifier: jest.fn(),
            codeVerifier: jest.fn(),
            invalidateCredentials: jest.fn()
        };

        mockFetch = jest.fn();
    });

    it('should add Authorization header when tokens are available (with explicit baseUrl)', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/data',
            expect.objectContaining({
                headers: expect.any(Headers)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer test-token');
    });

    it('should add Authorization header when tokens are available (without baseUrl)', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

        // Test without baseUrl - should extract from request URL
        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/data',
            expect.objectContaining({
                headers: expect.any(Headers)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer test-token');
    });

    it('should handle requests without tokens (without baseUrl)', async () => {
        mockProvider.tokens.mockResolvedValue(undefined);
        mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

        // Test without baseUrl
        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBeNull();
    });

    it('should retry request after successful auth on 401 response (with explicit baseUrl)', async () => {
        mockProvider.tokens
            .mockResolvedValueOnce({
                access_token: 'old-token',
                token_type: 'Bearer',
                expires_in: 3600
            })
            .mockResolvedValueOnce({
                access_token: 'new-token',
                token_type: 'Bearer',
                expires_in: 3600
            });

        const unauthorizedResponse = new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="oauth"' }
        });
        const successResponse = new Response('success', { status: 200 });

        mockFetch.mockResolvedValueOnce(unauthorizedResponse).mockResolvedValueOnce(successResponse);

        const mockResourceUrl = new URL('https://oauth.example.com/.well-known/oauth-protected-resource');
        mockExtractResourceMetadataUrl.mockReturnValue(mockResourceUrl);
        mockAuth.mockResolvedValue('AUTHORIZED');

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        const result = await enhancedFetch('https://api.example.com/data');

        expect(result).toBe(successResponse);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
            serverUrl: 'https://api.example.com',
            resourceMetadataUrl: mockResourceUrl,
            fetchFn: mockFetch
        });

        // Verify the retry used the new token
        const retryCallArgs = mockFetch.mock.calls[1];
        const retryHeaders = retryCallArgs[1]?.headers as Headers;
        expect(retryHeaders.get('Authorization')).toBe('Bearer new-token');
    });

    it('should retry request after successful auth on 401 response (without baseUrl)', async () => {
        mockProvider.tokens
            .mockResolvedValueOnce({
                access_token: 'old-token',
                token_type: 'Bearer',
                expires_in: 3600
            })
            .mockResolvedValueOnce({
                access_token: 'new-token',
                token_type: 'Bearer',
                expires_in: 3600
            });

        const unauthorizedResponse = new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="oauth"' }
        });
        const successResponse = new Response('success', { status: 200 });

        mockFetch.mockResolvedValueOnce(unauthorizedResponse).mockResolvedValueOnce(successResponse);

        const mockResourceUrl = new URL('https://oauth.example.com/.well-known/oauth-protected-resource');
        mockExtractResourceMetadataUrl.mockReturnValue(mockResourceUrl);
        mockAuth.mockResolvedValue('AUTHORIZED');

        // Test without baseUrl - should extract from request URL
        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        const result = await enhancedFetch('https://api.example.com/data');

        expect(result).toBe(successResponse);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
            serverUrl: 'https://api.example.com', // Should be extracted from request URL
            resourceMetadataUrl: mockResourceUrl,
            fetchFn: mockFetch
        });

        // Verify the retry used the new token
        const retryCallArgs = mockFetch.mock.calls[1];
        const retryHeaders = retryCallArgs[1]?.headers as Headers;
        expect(retryHeaders.get('Authorization')).toBe('Bearer new-token');
    });

    it('should throw UnauthorizedError when auth returns REDIRECT (without baseUrl)', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
        mockExtractResourceMetadataUrl.mockReturnValue(undefined);
        mockAuth.mockResolvedValue('REDIRECT');

        // Test without baseUrl
        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        await expect(enhancedFetch('https://api.example.com/data')).rejects.toThrow(
            'Authentication requires user authorization - redirect initiated'
        );
    });

    it('should throw UnauthorizedError when auth fails', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
        mockExtractResourceMetadataUrl.mockReturnValue(undefined);
        mockAuth.mockRejectedValue(new Error('Network error'));

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        await expect(enhancedFetch('https://api.example.com/data')).rejects.toThrow('Failed to re-authenticate: Network error');
    });

    it('should handle persistent 401 responses after auth', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        // Always return 401
        mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
        mockExtractResourceMetadataUrl.mockReturnValue(undefined);
        mockAuth.mockResolvedValue('AUTHORIZED');

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        await expect(enhancedFetch('https://api.example.com/data')).rejects.toThrow(
            'Authentication failed for https://api.example.com/data'
        );

        // Should have made initial request + 1 retry after auth = 2 total
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockAuth).toHaveBeenCalledTimes(1);
    });

    it('should preserve original request method and body', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        const requestBody = JSON.stringify({ data: 'test' });
        await enhancedFetch('https://api.example.com/data', {
            method: 'POST',
            body: requestBody,
            headers: { 'Content-Type': 'application/json' }
        });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/data',
            expect.objectContaining({
                method: 'POST',
                body: requestBody,
                headers: expect.any(Headers)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(headers.get('Authorization')).toBe('Bearer test-token');
    });

    it('should handle non-401 errors normally', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        const serverErrorResponse = new Response('Server Error', { status: 500 });
        mockFetch.mockResolvedValue(serverErrorResponse);

        const enhancedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

        const result = await enhancedFetch('https://api.example.com/data');

        expect(result).toBe(serverErrorResponse);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockAuth).not.toHaveBeenCalled();
    });

    it('should handle URL object as input (without baseUrl)', async () => {
        mockProvider.tokens.mockResolvedValue({
            access_token: 'test-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

        // Test URL object without baseUrl - should extract origin from URL object
        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        await enhancedFetch(new URL('https://api.example.com/data'));

        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(URL),
            expect.objectContaining({
                headers: expect.any(Headers)
            })
        );
    });

    it('should handle URL object in auth retry (without baseUrl)', async () => {
        mockProvider.tokens
            .mockResolvedValueOnce({
                access_token: 'old-token',
                token_type: 'Bearer',
                expires_in: 3600
            })
            .mockResolvedValueOnce({
                access_token: 'new-token',
                token_type: 'Bearer',
                expires_in: 3600
            });

        const unauthorizedResponse = new Response('Unauthorized', { status: 401 });
        const successResponse = new Response('success', { status: 200 });

        mockFetch.mockResolvedValueOnce(unauthorizedResponse).mockResolvedValueOnce(successResponse);

        mockExtractResourceMetadataUrl.mockReturnValue(undefined);
        mockAuth.mockResolvedValue('AUTHORIZED');

        const enhancedFetch = withOAuth(mockProvider)(mockFetch);

        const result = await enhancedFetch(new URL('https://api.example.com/data'));

        expect(result).toBe(successResponse);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
            serverUrl: 'https://api.example.com', // Should extract origin from URL object
            resourceMetadataUrl: undefined,
            fetchFn: mockFetch
        });
    });
});

describe('withLogging', () => {
    let mockFetch: jest.MockedFunction<FetchLike>;
    let mockLogger: jest.MockedFunction<
        (input: {
            method: string;
            url: string | URL;
            status: number;
            statusText: string;
            duration: number;
            requestHeaders?: Headers;
            responseHeaders?: Headers;
            error?: Error;
        }) => void
    >;
    let consoleErrorSpy: jest.SpyInstance;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();

        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        mockFetch = jest.fn();
        mockLogger = jest.fn();
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
    });

    it('should log successful requests with default logger', async () => {
        const response = new Response('success', { status: 200, statusText: 'OK' });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging()(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        expect(consoleLogSpy).toHaveBeenCalledWith(
            expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data 200 OK \(\d+\.\d+ms\)/)
        );
    });

    it('should log error responses with default logger', async () => {
        const response = new Response('Not Found', {
            status: 404,
            statusText: 'Not Found'
        });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging()(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data 404 Not Found \(\d+\.\d+ms\)/)
        );
    });

    it('should log network errors with default logger', async () => {
        const networkError = new Error('Network connection failed');
        mockFetch.mockRejectedValue(networkError);

        const enhancedFetch = withLogging()(mockFetch);

        await expect(enhancedFetch('https://api.example.com/data')).rejects.toThrow('Network connection failed');

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data failed: Network connection failed \(\d+\.\d+ms\)/)
        );
    });

    it('should use custom logger when provided', async () => {
        const response = new Response('success', { status: 200, statusText: 'OK' });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging({ logger: mockLogger })(mockFetch);

        await enhancedFetch('https://api.example.com/data', { method: 'POST' });

        expect(mockLogger).toHaveBeenCalledWith({
            method: 'POST',
            url: 'https://api.example.com/data',
            status: 200,
            statusText: 'OK',
            duration: expect.any(Number),
            requestHeaders: undefined,
            responseHeaders: undefined
        });

        expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should include request headers when configured', async () => {
        const response = new Response('success', { status: 200, statusText: 'OK' });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging({
            logger: mockLogger,
            includeRequestHeaders: true
        })(mockFetch);

        await enhancedFetch('https://api.example.com/data', {
            headers: {
                Authorization: 'Bearer token',
                'Content-Type': 'application/json'
            }
        });

        expect(mockLogger).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://api.example.com/data',
            status: 200,
            statusText: 'OK',
            duration: expect.any(Number),
            requestHeaders: expect.any(Headers),
            responseHeaders: undefined
        });

        const logCall = mockLogger.mock.calls[0][0];
        expect(logCall.requestHeaders?.get('Authorization')).toBe('Bearer token');
        expect(logCall.requestHeaders?.get('Content-Type')).toBe('application/json');
    });

    it('should include response headers when configured', async () => {
        const response = new Response('success', {
            status: 200,
            statusText: 'OK',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging({
            logger: mockLogger,
            includeResponseHeaders: true
        })(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        const logCall = mockLogger.mock.calls[0][0];
        expect(logCall.responseHeaders?.get('Content-Type')).toBe('application/json');
        expect(logCall.responseHeaders?.get('Cache-Control')).toBe('no-cache');
    });

    it('should respect statusLevel option', async () => {
        const successResponse = new Response('success', {
            status: 200,
            statusText: 'OK'
        });
        const errorResponse = new Response('Server Error', {
            status: 500,
            statusText: 'Internal Server Error'
        });

        mockFetch.mockResolvedValueOnce(successResponse).mockResolvedValueOnce(errorResponse);

        const enhancedFetch = withLogging({
            logger: mockLogger,
            statusLevel: 400
        })(mockFetch);

        // 200 response should not be logged (below statusLevel 400)
        await enhancedFetch('https://api.example.com/success');
        expect(mockLogger).not.toHaveBeenCalled();

        // 500 response should be logged (above statusLevel 400)
        await enhancedFetch('https://api.example.com/error');
        expect(mockLogger).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://api.example.com/error',
            status: 500,
            statusText: 'Internal Server Error',
            duration: expect.any(Number),
            requestHeaders: undefined,
            responseHeaders: undefined
        });
    });

    it('should always log network errors regardless of statusLevel', async () => {
        const networkError = new Error('Connection timeout');
        mockFetch.mockRejectedValue(networkError);

        const enhancedFetch = withLogging({
            logger: mockLogger,
            statusLevel: 500 // Very high log level
        })(mockFetch);

        await expect(enhancedFetch('https://api.example.com/data')).rejects.toThrow('Connection timeout');

        expect(mockLogger).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://api.example.com/data',
            status: 0,
            statusText: 'Network Error',
            duration: expect.any(Number),
            requestHeaders: undefined,
            error: networkError
        });
    });

    it('should include headers in default logger message when configured', async () => {
        const response = new Response('success', {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' }
        });
        mockFetch.mockResolvedValue(response);

        const enhancedFetch = withLogging({
            includeRequestHeaders: true,
            includeResponseHeaders: true
        })(mockFetch);

        await enhancedFetch('https://api.example.com/data', {
            headers: { Authorization: 'Bearer token' }
        });

        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Request Headers: {authorization: Bearer token}'));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Response Headers: {content-type: application/json}'));
    });

    it('should measure request duration accurately', async () => {
        // Mock a slow response
        const response = new Response('success', { status: 200 });
        mockFetch.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return response;
        });

        const enhancedFetch = withLogging({ logger: mockLogger })(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        const logCall = mockLogger.mock.calls[0][0];
        expect(logCall.duration).toBeGreaterThanOrEqual(90); // Allow some margin for timing
    });
});

describe('applyMiddleware', () => {
    let mockFetch: jest.MockedFunction<FetchLike>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFetch = jest.fn();
    });

    it('should compose no middleware correctly', () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        const composedFetch = applyMiddlewares()(mockFetch);

        expect(composedFetch).toBe(mockFetch);
    });

    it('should compose single middleware correctly', async () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        // Create a middleware that adds a header
        const middleware1 = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Middleware-1', 'applied');
            return next(input, { ...init, headers });
        };

        const composedFetch = applyMiddlewares(middleware1)(mockFetch);

        await composedFetch('https://api.example.com/data');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/data',
            expect.objectContaining({
                headers: expect.any(Headers)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('X-Middleware-1')).toBe('applied');
    });

    it('should compose multiple middleware in order', async () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        // Create middleware that add identifying headers
        const middleware1 = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Middleware-1', 'applied');
            return next(input, { ...init, headers });
        };

        const middleware2 = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Middleware-2', 'applied');
            return next(input, { ...init, headers });
        };

        const middleware3 = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Middleware-3', 'applied');
            return next(input, { ...init, headers });
        };

        const composedFetch = applyMiddlewares(middleware1, middleware2, middleware3)(mockFetch);

        await composedFetch('https://api.example.com/data');

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('X-Middleware-1')).toBe('applied');
        expect(headers.get('X-Middleware-2')).toBe('applied');
        expect(headers.get('X-Middleware-3')).toBe('applied');
    });

    it('should work with real fetch middleware functions', async () => {
        const response = new Response('success', { status: 200, statusText: 'OK' });
        mockFetch.mockResolvedValue(response);

        // Create middleware that add identifying headers
        const oauthMiddleware = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', 'Bearer test-token');
            return next(input, { ...init, headers });
        };

        // Use custom logger to avoid console output
        const mockLogger = jest.fn();
        const composedFetch = applyMiddlewares(oauthMiddleware, withLogging({ logger: mockLogger, statusLevel: 0 }))(mockFetch);

        await composedFetch('https://api.example.com/data');

        // Should have both Authorization header and logging
        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer test-token');
        expect(mockLogger).toHaveBeenCalledWith({
            method: 'GET',
            url: 'https://api.example.com/data',
            status: 200,
            statusText: 'OK',
            duration: expect.any(Number),
            requestHeaders: undefined,
            responseHeaders: undefined
        });
    });

    it('should preserve error propagation through middleware', async () => {
        const errorMiddleware = (next: FetchLike) => async (input: string | URL, init?: RequestInit) => {
            try {
                return await next(input, init);
            } catch (error) {
                // Add context to the error
                throw new Error(`Middleware error: ${error instanceof Error ? error.message : String(error)}`);
            }
        };

        const originalError = new Error('Network failure');
        mockFetch.mockRejectedValue(originalError);

        const composedFetch = applyMiddlewares(errorMiddleware)(mockFetch);

        await expect(composedFetch('https://api.example.com/data')).rejects.toThrow('Middleware error: Network failure');
    });
});

describe('Integration Tests', () => {
    let mockProvider: jest.Mocked<OAuthClientProvider>;
    let mockFetch: jest.MockedFunction<FetchLike>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockProvider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            tokens: jest.fn(),
            saveTokens: jest.fn(),
            clientInformation: jest.fn(),
            redirectToAuthorization: jest.fn(),
            saveCodeVerifier: jest.fn(),
            codeVerifier: jest.fn(),
            invalidateCredentials: jest.fn()
        };

        mockFetch = jest.fn();
    });

    it('should work with SSE transport pattern', async () => {
        // Simulate how SSE transport might use the middleware
        mockProvider.tokens.mockResolvedValue({
            access_token: 'sse-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        const response = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
        mockFetch.mockResolvedValue(response);

        // Use custom logger to avoid console output
        const mockLogger = jest.fn();
        const enhancedFetch = applyMiddlewares(
            withOAuth(mockProvider as OAuthClientProvider, 'https://mcp-server.example.com'),
            withLogging({ logger: mockLogger, statusLevel: 400 }) // Only log errors
        )(mockFetch);

        // Simulate SSE POST request
        await enhancedFetch('https://mcp-server.example.com/endpoint', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 1
            })
        });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://mcp-server.example.com/endpoint',
            expect.objectContaining({
                method: 'POST',
                headers: expect.any(Headers),
                body: expect.any(String)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer sse-token');
        expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('should work with StreamableHTTP transport pattern', async () => {
        // Simulate how StreamableHTTP transport might use the middleware
        mockProvider.tokens.mockResolvedValue({
            access_token: 'streamable-token',
            token_type: 'Bearer',
            expires_in: 3600
        });

        const response = new Response(null, {
            status: 202,
            headers: { 'mcp-session-id': 'session-123' }
        });
        mockFetch.mockResolvedValue(response);

        // Use custom logger to avoid console output
        const mockLogger = jest.fn();
        const enhancedFetch = applyMiddlewares(
            withOAuth(mockProvider as OAuthClientProvider, 'https://streamable-server.example.com'),
            withLogging({
                logger: mockLogger,
                includeResponseHeaders: true,
                statusLevel: 0
            })
        )(mockFetch);

        // Simulate StreamableHTTP initialization request
        await enhancedFetch('https://streamable-server.example.com/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'initialize',
                params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test' } },
                id: 1
            })
        });

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer streamable-token');
        expect(headers.get('Accept')).toBe('application/json, text/event-stream');
    });

    it('should handle auth retry in transport-like scenario', async () => {
        mockProvider.tokens
            .mockResolvedValueOnce({
                access_token: 'expired-token',
                token_type: 'Bearer',
                expires_in: 3600
            })
            .mockResolvedValueOnce({
                access_token: 'fresh-token',
                token_type: 'Bearer',
                expires_in: 3600
            });

        const unauthorizedResponse = new Response('{"error":"invalid_token"}', {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="mcp"' }
        });
        const successResponse = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
            status: 200
        });

        mockFetch.mockResolvedValueOnce(unauthorizedResponse).mockResolvedValueOnce(successResponse);

        mockExtractResourceMetadataUrl.mockReturnValue(new URL('https://auth.example.com/.well-known/oauth-protected-resource'));
        mockAuth.mockResolvedValue('AUTHORIZED');

        // Use custom logger to avoid console output
        const mockLogger = jest.fn();
        const enhancedFetch = applyMiddlewares(
            withOAuth(mockProvider as OAuthClientProvider, 'https://mcp-server.example.com'),
            withLogging({ logger: mockLogger, statusLevel: 0 })
        )(mockFetch);

        const result = await enhancedFetch('https://mcp-server.example.com/endpoint', {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', method: 'test', id: 1 })
        });

        expect(result).toBe(successResponse);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
            serverUrl: 'https://mcp-server.example.com',
            resourceMetadataUrl: new URL('https://auth.example.com/.well-known/oauth-protected-resource'),
            fetchFn: mockFetch
        });
    });
});

describe('createMiddleware', () => {
    let mockFetch: jest.MockedFunction<FetchLike>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockFetch = jest.fn();
    });

    it('should create middleware with cleaner syntax', async () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        const customMiddleware = createMiddleware(async (next, input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('X-Custom-Header', 'custom-value');
            return next(input, { ...init, headers });
        });

        const enhancedFetch = customMiddleware(mockFetch);
        await enhancedFetch('https://api.example.com/data');

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/data',
            expect.objectContaining({
                headers: expect.any(Headers)
            })
        );

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('X-Custom-Header')).toBe('custom-value');
    });

    it('should support conditional middleware logic', async () => {
        const apiResponse = new Response('api response', { status: 200 });
        const publicResponse = new Response('public response', { status: 200 });
        mockFetch.mockResolvedValueOnce(apiResponse).mockResolvedValueOnce(publicResponse);

        const conditionalMiddleware = createMiddleware(async (next, input, init) => {
            const url = typeof input === 'string' ? input : input.toString();

            if (url.includes('/api/')) {
                const headers = new Headers(init?.headers);
                headers.set('X-API-Version', 'v2');
                return next(input, { ...init, headers });
            }

            return next(input, init);
        });

        const enhancedFetch = conditionalMiddleware(mockFetch);

        // Test API route
        await enhancedFetch('https://example.com/api/users');
        let callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('X-API-Version')).toBe('v2');

        // Test non-API route
        await enhancedFetch('https://example.com/public/page');
        callArgs = mockFetch.mock.calls[1];
        const maybeHeaders = callArgs[1]?.headers as Headers | undefined;
        expect(maybeHeaders?.get('X-API-Version')).toBeUndefined();
    });

    it('should support short-circuit responses', async () => {
        const customMiddleware = createMiddleware(async (next, input, init) => {
            const url = typeof input === 'string' ? input : input.toString();

            // Short-circuit for specific URL
            if (url.includes('/cached')) {
                return new Response('cached data', { status: 200 });
            }

            return next(input, init);
        });

        const enhancedFetch = customMiddleware(mockFetch);

        // Test cached route (should not call mockFetch)
        const cachedResponse = await enhancedFetch('https://example.com/cached/data');
        expect(await cachedResponse.text()).toBe('cached data');
        expect(mockFetch).not.toHaveBeenCalled();

        // Test normal route
        mockFetch.mockResolvedValue(new Response('fresh data', { status: 200 }));
        const normalResponse = await enhancedFetch('https://example.com/normal/data');
        expect(await normalResponse.text()).toBe('fresh data');
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle response transformation', async () => {
        const originalResponse = new Response('{"data": "original"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
        mockFetch.mockResolvedValue(originalResponse);

        const transformMiddleware = createMiddleware(async (next, input, init) => {
            const response = await next(input, init);

            if (response.headers.get('content-type')?.includes('application/json')) {
                const data = await response.json();
                const transformed = { ...data, timestamp: 123456789 };

                return new Response(JSON.stringify(transformed), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            }

            return response;
        });

        const enhancedFetch = transformMiddleware(mockFetch);
        const response = await enhancedFetch('https://api.example.com/data');
        const result = await response.json();

        expect(result).toEqual({
            data: 'original',
            timestamp: 123456789
        });
    });

    it('should support error handling and recovery', async () => {
        let attemptCount = 0;
        mockFetch.mockImplementation(async () => {
            attemptCount++;
            if (attemptCount === 1) {
                throw new Error('Network error');
            }
            return new Response('success', { status: 200 });
        });

        const retryMiddleware = createMiddleware(async (next, input, init) => {
            try {
                return await next(input, init);
            } catch (error) {
                // Retry once on network error
                console.log('Retrying request after error:', error);
                return await next(input, init);
            }
        });

        const enhancedFetch = retryMiddleware(mockFetch);
        const response = await enhancedFetch('https://api.example.com/data');

        expect(await response.text()).toBe('success');
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should compose well with other middleware', async () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        // Create custom middleware using createMiddleware
        const customAuth = createMiddleware(async (next, input, init) => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', 'Custom token');
            return next(input, { ...init, headers });
        });

        const customLogging = createMiddleware(async (next, input, init) => {
            const url = typeof input === 'string' ? input : input.toString();
            console.log(`Request to: ${url}`);
            const response = await next(input, init);
            console.log(`Response status: ${response.status}`);
            return response;
        });

        // Compose with existing middleware
        const enhancedFetch = applyMiddlewares(customAuth, customLogging, withLogging({ statusLevel: 400 }))(mockFetch);

        await enhancedFetch('https://api.example.com/data');

        const callArgs = mockFetch.mock.calls[0];
        const headers = callArgs[1]?.headers as Headers;
        expect(headers.get('Authorization')).toBe('Custom token');
    });

    it('should have access to both input types (string and URL)', async () => {
        const response = new Response('success', { status: 200 });
        mockFetch.mockResolvedValue(response);

        let capturedInputType: string | undefined;
        const inspectMiddleware = createMiddleware(async (next, input, init) => {
            capturedInputType = typeof input === 'string' ? 'string' : 'URL';
            return next(input, init);
        });

        const enhancedFetch = inspectMiddleware(mockFetch);

        // Test with string input
        await enhancedFetch('https://api.example.com/data');
        expect(capturedInputType).toBe('string');

        // Test with URL input
        await enhancedFetch(new URL('https://api.example.com/data'));
        expect(capturedInputType).toBe('URL');
    });
});
