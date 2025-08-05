import { withOAuth, withLogging, withWrappers } from './fetchWrapper.js';
import { OAuthClientProvider } from '../client/auth.js';
import { FetchLike } from './transport.js';

jest.mock('../client/auth.js', () => {
  const actual = jest.requireActual('../client/auth.js');
  return {
    ...actual,
    auth: jest.fn(),
    extractResourceMetadataUrl: jest.fn(),
  };
});

import { auth, extractResourceMetadataUrl } from '../client/auth.js';

const mockAuth = auth as jest.MockedFunction<typeof auth>;
const mockExtractResourceMetadataUrl = extractResourceMetadataUrl as jest.MockedFunction<typeof extractResourceMetadataUrl>;

describe('withOAuth', () => {
  let mockProvider: jest.Mocked<OAuthClientProvider>;
  let mockFetch: jest.MockedFunction<FetchLike>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      get redirectUrl() { return "http://localhost/callback"; },
      get clientMetadata() { return { redirect_uris: ["http://localhost/callback"] }; },
      tokens: jest.fn(),
      saveTokens: jest.fn(),
      clientInformation: jest.fn(),
      redirectToAuthorization: jest.fn(),
      saveCodeVerifier: jest.fn(),
      codeVerifier: jest.fn(),
      invalidateCredentials: jest.fn(),
    };

    mockFetch = jest.fn();
  });

  it('should add Authorization header when tokens are available (with explicit baseUrl)', async () => {
    mockProvider.tokens.mockResolvedValue({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        headers: expect.any(Headers),
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
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

    // Test without baseUrl - should extract from request URL
    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        headers: expect.any(Headers),
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
    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    await wrappedFetch('https://api.example.com/data');

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
        expires_in: 3600,
      })
      .mockResolvedValueOnce({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    const unauthorizedResponse = new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="oauth"' }
    });
    const successResponse = new Response('success', { status: 200 });

    mockFetch
      .mockResolvedValueOnce(unauthorizedResponse)
      .mockResolvedValueOnce(successResponse);

    const mockResourceUrl = new URL('https://oauth.example.com/.well-known/oauth-protected-resource');
    mockExtractResourceMetadataUrl.mockReturnValue(mockResourceUrl);
    mockAuth.mockResolvedValue('AUTHORIZED');

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    const result = await wrappedFetch('https://api.example.com/data');

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
      serverUrl: 'https://api.example.com',
      resourceMetadataUrl: mockResourceUrl,
      fetchFn: mockFetch,
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
        expires_in: 3600,
      })
      .mockResolvedValueOnce({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    const unauthorizedResponse = new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="oauth"' }
    });
    const successResponse = new Response('success', { status: 200 });

    mockFetch
      .mockResolvedValueOnce(unauthorizedResponse)
      .mockResolvedValueOnce(successResponse);

    const mockResourceUrl = new URL('https://oauth.example.com/.well-known/oauth-protected-resource');
    mockExtractResourceMetadataUrl.mockReturnValue(mockResourceUrl);
    mockAuth.mockResolvedValue('AUTHORIZED');

    // Test without baseUrl - should extract from request URL
    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    const result = await wrappedFetch('https://api.example.com/data');

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
      serverUrl: 'https://api.example.com', // Should be extracted from request URL
      resourceMetadataUrl: mockResourceUrl,
      fetchFn: mockFetch,
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
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    mockExtractResourceMetadataUrl.mockReturnValue(undefined);
    mockAuth.mockResolvedValue('REDIRECT');

    // Test without baseUrl
    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow(
      'Authentication requires user authorization - redirect initiated'
    );
  });

  it('should throw UnauthorizedError when auth fails', async () => {
    mockProvider.tokens.mockResolvedValue({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    mockExtractResourceMetadataUrl.mockReturnValue(undefined);
    mockAuth.mockRejectedValue(new Error('Network error'));

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow(
      'Failed to re-authenticate: Network error'
    );
  });

  it('should handle persistent 401 responses after auth', async () => {
    mockProvider.tokens.mockResolvedValue({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    // Always return 401
    mockFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    mockExtractResourceMetadataUrl.mockReturnValue(undefined);
    mockAuth.mockResolvedValue('AUTHORIZED');

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow(
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
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    const requestBody = JSON.stringify({ data: 'test' });
    await wrappedFetch('https://api.example.com/data', {
      method: 'POST',
      body: requestBody,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        method: 'POST',
        body: requestBody,
        headers: expect.any(Headers),
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
      expires_in: 3600,
    });

    const serverErrorResponse = new Response('Server Error', { status: 500 });
    mockFetch.mockResolvedValue(serverErrorResponse);

    const wrappedFetch = withOAuth(mockProvider, 'https://api.example.com')(mockFetch);

    const result = await wrappedFetch('https://api.example.com/data');

    expect(result).toBe(serverErrorResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('should handle URL object as input (without baseUrl)', async () => {
    mockProvider.tokens.mockResolvedValue({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    mockFetch.mockResolvedValue(new Response('success', { status: 200 }));

    // Test URL object without baseUrl - should extract origin from URL object
    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    await wrappedFetch(new URL('https://api.example.com/data'));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
  });

  it('should handle URL object in auth retry (without baseUrl)', async () => {
    mockProvider.tokens
      .mockResolvedValueOnce({
        access_token: 'old-token',
        token_type: 'Bearer',
        expires_in: 3600,
      })
      .mockResolvedValueOnce({
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    const unauthorizedResponse = new Response('Unauthorized', { status: 401 });
    const successResponse = new Response('success', { status: 200 });

    mockFetch
      .mockResolvedValueOnce(unauthorizedResponse)
      .mockResolvedValueOnce(successResponse);

    mockExtractResourceMetadataUrl.mockReturnValue(undefined);
    mockAuth.mockResolvedValue('AUTHORIZED');

    const wrappedFetch = withOAuth(mockProvider)(mockFetch);

    const result = await wrappedFetch(new URL('https://api.example.com/data'));

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
      serverUrl: 'https://api.example.com', // Should extract origin from URL object
      resourceMetadataUrl: undefined,
      fetchFn: mockFetch,
    });
  });
});

describe('withLogging', () => {
  let mockFetch: jest.MockedFunction<FetchLike>;
  let mockLogger: jest.MockedFunction<(input: {
    method: string;
    url: string | URL;
    status: number;
    statusText: string;
    duration: number;
    requestHeaders?: Headers;
    responseHeaders?: Headers;
    error?: Error;
  }) => void>;
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

    const wrappedFetch = withLogging()(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data 200 OK \(\d+\.\d+ms\)/)
    );
  });

  it('should log error responses with default logger', async () => {
    const response = new Response('Not Found', { status: 404, statusText: 'Not Found' });
    mockFetch.mockResolvedValue(response);

    const wrappedFetch = withLogging()(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data 404 Not Found \(\d+\.\d+ms\)/)
    );
  });

  it('should log network errors with default logger', async () => {
    const networkError = new Error('Network connection failed');
    mockFetch.mockRejectedValue(networkError);

    const wrappedFetch = withLogging()(mockFetch);

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow('Network connection failed');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/HTTP GET https:\/\/api\.example\.com\/data failed: Network connection failed \(\d+\.\d+ms\)/)
    );
  });

  it('should use custom logger when provided', async () => {
    const response = new Response('success', { status: 200, statusText: 'OK' });
    mockFetch.mockResolvedValue(response);

    const wrappedFetch = withLogging({ logger: mockLogger })(mockFetch);

    await wrappedFetch('https://api.example.com/data', { method: 'POST' });

    expect(mockLogger).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example.com/data',
      status: 200,
      statusText: 'OK',
      duration: expect.any(Number),
      requestHeaders: undefined,
      responseHeaders: undefined,
    });

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('should include request headers when configured', async () => {
    const response = new Response('success', { status: 200, statusText: 'OK' });
    mockFetch.mockResolvedValue(response);

    const wrappedFetch = withLogging({
      logger: mockLogger,
      includeRequestHeaders: true
    })(mockFetch);

    await wrappedFetch('https://api.example.com/data', {
      headers: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' }
    });

    expect(mockLogger).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.example.com/data',
      status: 200,
      statusText: 'OK',
      duration: expect.any(Number),
      requestHeaders: expect.any(Headers),
      responseHeaders: undefined,
    });

    const logCall = mockLogger.mock.calls[0][0];
    expect(logCall.requestHeaders?.get('Authorization')).toBe('Bearer token');
    expect(logCall.requestHeaders?.get('Content-Type')).toBe('application/json');
  });

  it('should include response headers when configured', async () => {
    const response = new Response('success', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
    mockFetch.mockResolvedValue(response);

    const wrappedFetch = withLogging({
      logger: mockLogger,
      includeResponseHeaders: true
    })(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    const logCall = mockLogger.mock.calls[0][0];
    expect(logCall.responseHeaders?.get('Content-Type')).toBe('application/json');
    expect(logCall.responseHeaders?.get('Cache-Control')).toBe('no-cache');
  });

  it('should respect statusLevel option', async () => {
    const successResponse = new Response('success', { status: 200, statusText: 'OK' });
    const errorResponse = new Response('Server Error', { status: 500, statusText: 'Internal Server Error' });

    mockFetch
      .mockResolvedValueOnce(successResponse)
      .mockResolvedValueOnce(errorResponse);

    const wrappedFetch = withLogging({
      logger: mockLogger,
      statusLevel: 400
    })(mockFetch);

    // 200 response should not be logged (below statusLevel 400)
    await wrappedFetch('https://api.example.com/success');
    expect(mockLogger).not.toHaveBeenCalled();

    // 500 response should be logged (above statusLevel 400)
    await wrappedFetch('https://api.example.com/error');
    expect(mockLogger).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.example.com/error',
      status: 500,
      statusText: 'Internal Server Error',
      duration: expect.any(Number),
      requestHeaders: undefined,
      responseHeaders: undefined,
    });
  });

  it('should always log network errors regardless of statusLevel', async () => {
    const networkError = new Error('Connection timeout');
    mockFetch.mockRejectedValue(networkError);

    const wrappedFetch = withLogging({
      logger: mockLogger,
      statusLevel: 500  // Very high log level
    })(mockFetch);

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow('Connection timeout');

    expect(mockLogger).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.example.com/data',
      status: 0,
      statusText: 'Network Error',
      duration: expect.any(Number),
      requestHeaders: undefined,
      error: networkError,
    });
  });

  it('should include headers in default logger message when configured', async () => {
    const response = new Response('success', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' }
    });
    mockFetch.mockResolvedValue(response);

    const wrappedFetch = withLogging({
      includeRequestHeaders: true,
      includeResponseHeaders: true
    })(mockFetch);

    await wrappedFetch('https://api.example.com/data', {
      headers: { 'Authorization': 'Bearer token' }
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Request Headers: {authorization: Bearer token}')
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Response Headers: {content-type: application/json}')
    );
  });

  it('should measure request duration accurately', async () => {
    // Mock a slow response
    const response = new Response('success', { status: 200 });
    mockFetch.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return response;
    });

    const wrappedFetch = withLogging({ logger: mockLogger })(mockFetch);

    await wrappedFetch('https://api.example.com/data');

    const logCall = mockLogger.mock.calls[0][0];
    expect(logCall.duration).toBeGreaterThanOrEqual(90); // Allow some margin for timing
  });
});

describe('withWrappers', () => {
  let mockFetch: jest.MockedFunction<FetchLike>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
  });

  it('should compose no wrappers correctly', () => {
    const response = new Response('success', { status: 200 });
    mockFetch.mockResolvedValue(response);

    const composedFetch = withWrappers()(mockFetch);

    expect(composedFetch).toBe(mockFetch);
  });

  it('should compose single wrapper correctly', async () => {
    const response = new Response('success', { status: 200 });
    mockFetch.mockResolvedValue(response);

    // Create a wrapper that adds a header
    const wrapper1 = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Wrapper-1', 'applied');
      return fetch(input, { ...init, headers });
    };

    const composedFetch = withWrappers(wrapper1)(mockFetch);

    await composedFetch('https://api.example.com/data');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/data',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Headers;
    expect(headers.get('X-Wrapper-1')).toBe('applied');
  });

  it('should compose multiple wrappers in order', async () => {
    const response = new Response('success', { status: 200 });
    mockFetch.mockResolvedValue(response);

    // Create wrappers that add identifying headers
    const wrapper1 = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Wrapper-1', 'applied');
      return fetch(input, { ...init, headers });
    };

    const wrapper2 = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Wrapper-2', 'applied');
      return fetch(input, { ...init, headers });
    };

    const wrapper3 = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('X-Wrapper-3', 'applied');
      return fetch(input, { ...init, headers });
    };

    const composedFetch = withWrappers(wrapper1, wrapper2, wrapper3)(mockFetch);

    await composedFetch('https://api.example.com/data');

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Headers;
    expect(headers.get('X-Wrapper-1')).toBe('applied');
    expect(headers.get('X-Wrapper-2')).toBe('applied');
    expect(headers.get('X-Wrapper-3')).toBe('applied');
  });

    it('should work with real fetchWrapper functions', async () => {
    const response = new Response('success', { status: 200, statusText: 'OK' });
    mockFetch.mockResolvedValue(response);

    // Create wrappers that add identifying headers
    const oauthWrapper = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', 'Bearer test-token');
      return fetch(input, { ...init, headers });
    };

    // Use custom logger to avoid console output
    const mockLogger = jest.fn();
    const composedFetch = withWrappers(
      oauthWrapper,
      withLogging({ logger: mockLogger, statusLevel: 0 })
    )(mockFetch);

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
      responseHeaders: undefined,
    });
  });

  it('should preserve error propagation through wrappers', async () => {
    const errorWrapper = (fetch: FetchLike) => async (input: string | URL, init?: RequestInit) => {
      try {
        return await fetch(input, init);
      } catch (error) {
        // Add context to the error
        throw new Error(`Wrapper error: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const originalError = new Error('Network failure');
    mockFetch.mockRejectedValue(originalError);

    const composedFetch = withWrappers(errorWrapper)(mockFetch);

    await expect(composedFetch('https://api.example.com/data')).rejects.toThrow(
      'Wrapper error: Network failure'
    );
  });
});

describe('Integration Tests', () => {
  let mockProvider: jest.Mocked<OAuthClientProvider>;
  let mockFetch: jest.MockedFunction<FetchLike>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockProvider = {
      get redirectUrl() { return "http://localhost/callback"; },
      get clientMetadata() { return { redirect_uris: ["http://localhost/callback"] }; },
      tokens: jest.fn(),
      saveTokens: jest.fn(),
      clientInformation: jest.fn(),
      redirectToAuthorization: jest.fn(),
      saveCodeVerifier: jest.fn(),
      codeVerifier: jest.fn(),
      invalidateCredentials: jest.fn(),
    };

    mockFetch = jest.fn();
  });

  it('should work with SSE transport pattern', async () => {
    // Simulate how SSE transport might use the wrapper
    mockProvider.tokens.mockResolvedValue({
      access_token: 'sse-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const response = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    mockFetch.mockResolvedValue(response);

    // Use custom logger to avoid console output
    const mockLogger = jest.fn();
    const wrappedFetch = withWrappers(
      withOAuth(mockProvider as OAuthClientProvider, 'https://mcp-server.example.com'),
      withLogging({ logger: mockLogger, statusLevel: 400 }) // Only log errors
    )(mockFetch);

    // Simulate SSE POST request
    await wrappedFetch('https://mcp-server.example.com/endpoint', {
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
        body: expect.any(String),
      })
    );

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sse-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('should work with StreamableHTTP transport pattern', async () => {
    // Simulate how StreamableHTTP transport might use the wrapper
    mockProvider.tokens.mockResolvedValue({
      access_token: 'streamable-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const response = new Response(null, {
      status: 202,
      headers: { 'mcp-session-id': 'session-123' }
    });
    mockFetch.mockResolvedValue(response);

    // Use custom logger to avoid console output
    const mockLogger = jest.fn();
    const wrappedFetch = withWrappers(
      withOAuth(mockProvider as OAuthClientProvider, 'https://streamable-server.example.com'),
      withLogging({
        logger: mockLogger,
        includeResponseHeaders: true,
        statusLevel: 0
      })
    )(mockFetch);

    // Simulate StreamableHTTP initialization request
    await wrappedFetch('https://streamable-server.example.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
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
        expires_in: 3600,
      })
      .mockResolvedValueOnce({
        access_token: 'fresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });

    const unauthorizedResponse = new Response('{"error":"invalid_token"}', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="mcp"' }
    });
    const successResponse = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200
    });

    mockFetch
      .mockResolvedValueOnce(unauthorizedResponse)
      .mockResolvedValueOnce(successResponse);

    mockExtractResourceMetadataUrl.mockReturnValue(
      new URL('https://auth.example.com/.well-known/oauth-protected-resource')
    );
    mockAuth.mockResolvedValue('AUTHORIZED');

    // Use custom logger to avoid console output
    const mockLogger = jest.fn();
    const wrappedFetch = withWrappers(
      withOAuth(mockProvider as OAuthClientProvider, 'https://mcp-server.example.com'),
      withLogging({ logger: mockLogger, statusLevel: 0 })
    )(mockFetch);

    const result = await wrappedFetch('https://mcp-server.example.com/endpoint', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'test', id: 1 })
    });

    expect(result).toBe(successResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockAuth).toHaveBeenCalledWith(mockProvider, {
      serverUrl: 'https://mcp-server.example.com',
      resourceMetadataUrl: new URL('https://auth.example.com/.well-known/oauth-protected-resource'),
      fetchFn: mockFetch,
    });
  });
});
