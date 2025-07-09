import { LATEST_PROTOCOL_VERSION } from '../types.js';
import {
  discoverOAuthMetadata,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  discoverOAuthProtectedResourceMetadata,
  extractResourceMetadataUrl,
  auth,
  type OAuthClientProvider,
} from "./auth.js";

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("OAuth Authorization", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("extractResourceMetadataUrl", () => {
    it("returns resource metadata url when present", async () => {
      const resourceUrl = "https://resource.example.com/.well-known/oauth-protected-resource"
      const mockResponse = {
        headers: {
          get: jest.fn((name) => name === "WWW-Authenticate" ? `Bearer realm="mcp", resource_metadata="${resourceUrl}"` : null),
        }
      } as unknown as Response

      expect(extractResourceMetadataUrl(mockResponse)).toEqual(new URL(resourceUrl));
    });

    it("returns undefined if not bearer", async () => {
      const resourceUrl = "https://resource.example.com/.well-known/oauth-protected-resource"
      const mockResponse = {
        headers: {
          get: jest.fn((name) => name === "WWW-Authenticate" ? `Basic realm="mcp", resource_metadata="${resourceUrl}"` : null),
        }
      } as unknown as Response

      expect(extractResourceMetadataUrl(mockResponse)).toBeUndefined();
    });

    it("returns undefined if resource_metadata not present", async () => {
      const mockResponse = {
        headers: {
          get: jest.fn((name) => name === "WWW-Authenticate" ? `Basic realm="mcp"` : null),
        }
      } as unknown as Response

      expect(extractResourceMetadataUrl(mockResponse)).toBeUndefined();
    });

    it("returns undefined on invalid url", async () => {
      const resourceUrl = "invalid-url"
      const mockResponse = {
        headers: {
          get: jest.fn((name) => name === "WWW-Authenticate" ? `Basic realm="mcp", resource_metadata="${resourceUrl}"` : null),
        }
      } as unknown as Response

      expect(extractResourceMetadataUrl(mockResponse)).toBeUndefined();
    });
  });

  describe("discoverOAuthProtectedResourceMetadata", () => {
    const validMetadata = {
      resource: "https://resource.example.com",
      authorization_servers: ["https://auth.example.com"],
    };

    it("returns metadata when discovery succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com");
      expect(metadata).toEqual(validMetadata);
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1);
      const [url] = calls[0];
      expect(url.toString()).toBe("https://resource.example.com/.well-known/oauth-protected-resource");
    });

    it("returns metadata when first fetch fails but second without MCP header succeeds", async () => {
      // Set up a counter to control behavior
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call with MCP header - fail with TypeError (simulating CORS error)
          // We need to use TypeError specifically because that's what the implementation checks for
          return Promise.reject(new TypeError("Network error"));
        } else {
          // Second call without header - succeed
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => validMetadata
          });
        }
      });

      // Should succeed with the second call
      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com");
      expect(metadata).toEqual(validMetadata);

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify first call had MCP header
      expect(mockFetch.mock.calls[0][1]?.headers).toHaveProperty("MCP-Protocol-Version");
    });

    it("throws an error when all fetch attempts fail", async () => {
      // Set up a counter to control behavior
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call - fail with TypeError
          return Promise.reject(new TypeError("First failure"));
        } else {
          // Second call - fail with different error
          return Promise.reject(new Error("Second failure"));
        }
      });

      // Should fail with the second error
      await expect(discoverOAuthProtectedResourceMetadata("https://resource.example.com"))
        .rejects.toThrow("Second failure");

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws on 404 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(discoverOAuthProtectedResourceMetadata("https://resource.example.com"))
        .rejects.toThrow("Resource server does not implement OAuth 2.0 Protected Resource Metadata.");
    });

    it("throws on non-404 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(discoverOAuthProtectedResourceMetadata("https://resource.example.com"))
        .rejects.toThrow("HTTP 500");
    });

    it("validates metadata schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          scopes_supported: ["email", "mcp"],
        }),
      });

      await expect(discoverOAuthProtectedResourceMetadata("https://resource.example.com"))
        .rejects.toThrow();
    });
  });

  describe("discoverOAuthMetadata", () => {
    const validMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    };

    it("returns metadata when discovery succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(metadata).toEqual(validMetadata);
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1);
      const [url, options] = calls[0];
      expect(url.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
    });

    it("returns metadata when discovery succeeds with path", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/path/name");
      expect(metadata).toEqual(validMetadata);
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(2);
      const [url, options] = calls[1];
      expect(url.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server/path/name");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
    });

    it("returns metadata when discovery succeeds with authorization server url", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/provided-path/.well-known/oauth-authorization-server");
      expect(metadata).toEqual(validMetadata);
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1);
      const [url, options] = calls[0];
      expect(url.toString()).toBe("https://auth.example.com/provided-path/.well-known/oauth-authorization-server");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
    });

    it("falls back to root discovery when path-aware discovery returns 404", async () => {
      // First call (authorization server url) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Second call (path-aware) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Third call (root fallback) succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/path/name");
      expect(metadata).toEqual(validMetadata);
      
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(3);
      
      // First call should be authorization server url
      const [firstUrl, firstOptions] = calls[0];
      expect(firstUrl.toString()).toBe("https://auth.example.com/path/name");
      expect(firstOptions.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
      
      // Second call should be path-aware
      const [secondUrl, secondOptions] = calls[1];
      expect(secondUrl.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server/path/name");
      expect(secondOptions.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });

      // Third call should be root fallback
      const [thirdUrl, thirdOptions] = calls[2];
      expect(thirdUrl.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(thirdOptions.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
    });

    it("returns undefined when all discovery methods return 404", async () => {
      // First call (direct issuer URL) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Second call (path-aware) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Third call (root fallback) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/path/name");
      expect(metadata).toBeUndefined();
      
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(3);
    });

    it("does not fallback when the original URL is already at root path", async () => {
      // First call (direct issuer URL) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/");
      expect(metadata).toBeUndefined();
      
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1); // Should not attempt fallback
      
      const [url] = calls[0];
      expect(url.toString()).toBe("https://auth.example.com/");
    });

    it("does not fallback when the original URL has no path", async () => {
      // First call (direct issuer URL) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toBeUndefined();
      
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1); // Should not attempt fallback
      
      const [url] = calls[0];
      expect(url.toString()).toBe("https://auth.example.com/");
    });

    it("falls back when direct issuer URL encounters CORS error", async () => {
      // First call (direct issuer URL) fails with TypeError (CORS)
      mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError("CORS error")));
      
      // Retry direct issuer URL without headers (simulating CORS retry)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Second call (path-aware) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      
      // Third call (root fallback) succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com/deep/path");
      expect(metadata).toEqual(validMetadata);
      
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(4);
      
      // Final call should be root fallback
      const [lastUrl, lastOptions] = calls[3];
      expect(lastUrl.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(lastOptions.headers).toEqual({
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION
      });
    });

    it("returns metadata when first fetch fails but second without MCP header succeeds", async () => {
      // Set up a counter to control behavior
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call with MCP header - fail with TypeError (simulating CORS error)
          // We need to use TypeError specifically because that's what the implementation checks for
          return Promise.reject(new TypeError("Network error"));
        } else {
          // Second call without header - succeed
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => validMetadata
          });
        }
      });

      // Should succeed with the second call
      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toEqual(validMetadata);

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify first call had MCP header
      expect(mockFetch.mock.calls[0][1]?.headers).toHaveProperty("MCP-Protocol-Version");
    });

    it("throws an error when all fetch attempts fail", async () => {
      // Set up a counter to control behavior
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call - fail with TypeError
          return Promise.reject(new TypeError("First failure"));
        } else {
          // Second call - fail with different error
          return Promise.reject(new Error("Second failure"));
        }
      });

      // Should fail with the second error
      await expect(discoverOAuthMetadata("https://auth.example.com"))
        .rejects.toThrow("Second failure");

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns undefined when both CORS requests fail in fetchWithCorsRetry", async () => {
      // fetchWithCorsRetry tries with headers (fails with CORS), then retries without headers (also fails with CORS)
      // simulating a 404 w/o headers set. We want this to return undefined, not throw TypeError
      mockFetch.mockImplementation(() => {
        // Both the initial request with headers and retry without headers fail with CORS TypeError
        return Promise.reject(new TypeError("Failed to fetch"));
      });

      // This should return undefined (the desired behavior after the fix)
      const metadata = await discoverOAuthMetadata("https://auth.example.com/path");
      expect(metadata).toBeUndefined();
    });

    it("returns undefined when discovery endpoint returns 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toBeUndefined();
    });

    it("throws on non-404 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(
        discoverOAuthMetadata("https://auth.example.com")
      ).rejects.toThrow("HTTP 500");
    });

    it("validates metadata schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          issuer: "https://auth.example.com",
        }),
      });

      await expect(
        discoverOAuthMetadata("https://auth.example.com")
      ).rejects.toThrow();
    });
  });

  describe("startAuthorization", () => {
    const validMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/auth",
      token_endpoint: "https://auth.example.com/tkn",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    };

    const validClientInfo = {
      client_id: "client123",
      client_secret: "secret123",
      redirect_uris: ["http://localhost:3000/callback"],
      client_name: "Test Client",
    };

    it("generates authorization URL with PKCE challenge", async () => {
      const { authorizationUrl, codeVerifier } = await startAuthorization(
        "https://auth.example.com",
        {
          metadata: undefined,
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
          resource: new URL("https://api.example.com/mcp-server"),
        }
      );

      expect(authorizationUrl.toString()).toMatch(
        /^https:\/\/auth\.example\.com\/authorize\?/
      );
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("code_challenge")).toBe("test_challenge");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        "S256"
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/callback"
      );
      expect(authorizationUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
      expect(codeVerifier).toBe("test_verifier");
    });

    it("includes scope parameter when provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
          scope: "read write profile",
        }
      );

      expect(authorizationUrl.searchParams.get("scope")).toBe("read write profile");
    });

    it("excludes scope parameter when not provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.searchParams.has("scope")).toBe(false);
    });

    it("includes state parameter when provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
          state: "foobar",
        }
      );

      expect(authorizationUrl.searchParams.get("state")).toBe("foobar");
    });

    it("excludes state parameter when not provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.searchParams.has("state")).toBe(false);
    });

    it("uses metadata authorization_endpoint when provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          metadata: validMetadata,
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.toString()).toMatch(
        /^https:\/\/auth\.example\.com\/auth\?/
      );
    });

    it("validates response type support", async () => {
      const metadata = {
        ...validMetadata,
        response_types_supported: ["token"], // Does not support 'code'
      };

      await expect(
        startAuthorization("https://auth.example.com", {
          metadata,
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        })
      ).rejects.toThrow(/does not support response type/);
    });

    it("validates PKCE support", async () => {
      const metadata = {
        ...validMetadata,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["plain"], // Does not support 'S256'
      };

      await expect(
        startAuthorization("https://auth.example.com", {
          metadata,
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        })
      ).rejects.toThrow(/does not support code challenge method/);
    });
  });

  describe("exchangeAuthorization", () => {
    const validTokens = {
      access_token: "access123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh123",
    };

    const validClientInfo = {
      client_id: "client123",
      client_secret: "secret123",
      redirect_uris: ["http://localhost:3000/callback"],
      client_name: "Test Client",
    };

    it("exchanges code for tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokens,
      });

      const tokens = await exchangeAuthorization("https://auth.example.com", {
        clientInformation: validClientInfo,
        authorizationCode: "code123",
        codeVerifier: "verifier123",
        redirectUri: "http://localhost:3000/callback",
        resource: new URL("https://api.example.com/mcp-server"),
      });

      expect(tokens).toEqual(validTokens);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/token",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      );

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code123");
      expect(body.get("code_verifier")).toBe("verifier123");
      expect(body.get("client_id")).toBe("client123");
      expect(body.get("client_secret")).toBe("secret123");
      expect(body.get("redirect_uri")).toBe("http://localhost:3000/callback");
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("validates token response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          access_token: "access123",
        }),
      });

      await expect(
        exchangeAuthorization("https://auth.example.com", {
          clientInformation: validClientInfo,
          authorizationCode: "code123",
          codeVerifier: "verifier123",
          redirectUri: "http://localhost:3000/callback",
        })
      ).rejects.toThrow();
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        exchangeAuthorization("https://auth.example.com", {
          clientInformation: validClientInfo,
          authorizationCode: "code123",
          codeVerifier: "verifier123",
          redirectUri: "http://localhost:3000/callback",
        })
      ).rejects.toThrow("Token exchange failed");
    });
  });

  describe("refreshAuthorization", () => {
    const validTokens = {
      access_token: "newaccess123",
      token_type: "Bearer",
      expires_in: 3600,
    }
    const validTokensWithNewRefreshToken = {
      ...validTokens,
      refresh_token: "newrefresh123",
    };

    const validClientInfo = {
      client_id: "client123",
      client_secret: "secret123",
      redirect_uris: ["http://localhost:3000/callback"],
      client_name: "Test Client",
    };

    it("exchanges refresh token for new tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokensWithNewRefreshToken,
      });

      const tokens = await refreshAuthorization("https://auth.example.com", {
        clientInformation: validClientInfo,
        refreshToken: "refresh123",
        resource: new URL("https://api.example.com/mcp-server"),
      });

      expect(tokens).toEqual(validTokensWithNewRefreshToken);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/token",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        })
      );

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh123");
      expect(body.get("client_id")).toBe("client123");
      expect(body.get("client_secret")).toBe("secret123");
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("exchanges refresh token for new tokens and keep existing refresh token if none is returned", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokens,
      });

      const refreshToken = "refresh123";
      const tokens = await refreshAuthorization("https://auth.example.com", {
        clientInformation: validClientInfo,
        refreshToken,
      });

      expect(tokens).toEqual({ refresh_token: refreshToken, ...validTokens });
    });

    it("validates token response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          access_token: "newaccess123",
        }),
      });

      await expect(
        refreshAuthorization("https://auth.example.com", {
          clientInformation: validClientInfo,
          refreshToken: "refresh123",
        })
      ).rejects.toThrow();
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        refreshAuthorization("https://auth.example.com", {
          clientInformation: validClientInfo,
          refreshToken: "refresh123",
        })
      ).rejects.toThrow("Token refresh failed");
    });
  });

  describe("registerClient", () => {
    const validClientMetadata = {
      redirect_uris: ["http://localhost:3000/callback"],
      client_name: "Test Client",
    };

    const validClientInfo = {
      client_id: "client123",
      client_secret: "secret123",
      client_id_issued_at: 1612137600,
      client_secret_expires_at: 1612224000,
      ...validClientMetadata,
    };

    it("registers client and returns client information", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validClientInfo,
      });

      const clientInfo = await registerClient("https://auth.example.com", {
        clientMetadata: validClientMetadata,
      });

      expect(clientInfo).toEqual(validClientInfo);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: "https://auth.example.com/register",
        }),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(validClientMetadata),
        })
      );
    });

    it("validates client information response schema", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          // Missing required fields
          client_secret: "secret123",
        }),
      });

      await expect(
        registerClient("https://auth.example.com", {
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow();
    });

    it("throws when registration endpoint not available in metadata", async () => {
      const metadata = {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      };

      await expect(
        registerClient("https://auth.example.com", {
          metadata,
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow(/does not support dynamic client registration/);
    });

    it("throws on error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        registerClient("https://auth.example.com", {
          clientMetadata: validClientMetadata,
        })
      ).rejects.toThrow("Dynamic client registration failed");
    });
  });

  describe("auth function", () => {
    const mockProvider: OAuthClientProvider = {
      get redirectUrl() { return "http://localhost:3000/callback"; },
      get clientMetadata() {
        return {
          redirect_uris: ["http://localhost:3000/callback"],
          client_name: "Test Client",
        };
      },
      clientInformation: jest.fn(),
      tokens: jest.fn(),
      saveTokens: jest.fn(),
      redirectToAuthorization: jest.fn(),
      saveCodeVerifier: jest.fn(),
      codeVerifier: jest.fn(),
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("falls back to /.well-known/oauth-authorization-server when no protected-resource-metadata", async () => {
      // Setup: First call to protected resource metadata fails (404)
      // Second call to auth server metadata succeeds
      let callCount = 0;
      mockFetch.mockImplementation((url) => {
        callCount++;

        const urlString = url.toString();

        if (callCount === 1 && urlString.includes("/.well-known/oauth-protected-resource")) {
          // First call - protected resource metadata fails with 404
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (callCount === 2 && urlString === "https://resource.example.com/path") {
          // Second call - discoverOAuthMetadata server URL fails with 404
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (callCount === 3 && urlString.includes("/.well-known/oauth-authorization-server")) {
          // Third call - auth server metadata succeeds, falls back to path aware /.well-known/oauth-authorization-server
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              registration_endpoint: "https://auth.example.com/register",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (callCount === 4 && urlString.includes("/register")) {
          // Third call - client registration succeeds
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              client_id: "test-client-id",
              client_secret: "test-client-secret",
              client_id_issued_at: 1612137600,
              client_secret_expires_at: 1612224000,
              redirect_uris: ["http://localhost:3000/callback"],
              client_name: "Test Client",
            }),
          });
        }

        return Promise.reject(new Error(`Unexpected fetch call: ${urlString}`));
      });

      // Mock provider methods
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      mockProvider.saveClientInformation = jest.fn();

      // Call the auth function
      const result = await auth(mockProvider, {
        serverUrl: "https://resource.example.com/path",
      });

      // Verify the result
      expect(result).toBe("REDIRECT");

      // Verify the sequence of calls
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // First call should be to protected resource metadata
      expect(mockFetch.mock.calls[0][0].toString()).toBe(
        "https://resource.example.com/.well-known/oauth-protected-resource"
      );

      // Second call should be to server URL
      expect(mockFetch.mock.calls[1][0].toString()).toBe(
        "https://resource.example.com/path"
      );

      // Third call should be to oauth metadata
      expect(mockFetch.mock.calls[2][0].toString()).toBe(
        "https://resource.example.com/.well-known/oauth-authorization-server/path"
      );

      // Fourth call should be to registration endpoint
      expect(mockFetch.mock.calls[3][0].toString()).toBe(
        "https://auth.example.com/register"
      );
    });

    it("passes resource parameter through authorization flow", async () => {
      // Mock successful metadata discovery - need to include protected resource metadata
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for authorization flow
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Call auth without authorization code (should trigger redirect)
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("REDIRECT");

      // Verify the authorization URL includes the resource parameter
      expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );

      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl: URL = redirectCall[0];
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("includes resource in token exchange when authorization code is provided", async () => {
      // Mock successful metadata discovery and token exchange - need protected resource metadata
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (urlString.includes("/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "access123",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh123",
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token exchange
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.codeVerifier as jest.Mock).mockResolvedValue("test-verifier");
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with authorization code
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        authorizationCode: "auth-code-123",
      });

      expect(result).toBe("AUTHORIZED");

      // Find the token exchange call
      const tokenCall = mockFetch.mock.calls.find(call =>
        call[0].toString().includes("/token")
      );
      expect(tokenCall).toBeDefined();

      const body = tokenCall![1].body as URLSearchParams;
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
      expect(body.get("code")).toBe("auth-code-123");
    });

    it("includes resource in token refresh", async () => {
      // Mock successful metadata discovery and token refresh - need protected resource metadata
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (urlString.includes("/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "new-access123",
              token_type: "Bearer",
              expires_in: 3600,
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token refresh
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue({
        access_token: "old-access",
        refresh_token: "refresh123",
      });
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with existing tokens (should trigger refresh)
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("AUTHORIZED");

      // Find the token refresh call
      const tokenCall = mockFetch.mock.calls.find(call =>
        call[0].toString().includes("/token")
      );
      expect(tokenCall).toBeDefined();

      const body = tokenCall![1].body as URLSearchParams;
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh123");
    });

    it("skips default PRM resource validation when custom validateResourceURL is provided", async () => {
      const mockValidateResourceURL = jest.fn().mockResolvedValue(undefined);
      const providerWithCustomValidation = {
        ...mockProvider,
        validateResourceURL: mockValidateResourceURL,
      };

      // Mock protected resource metadata with mismatched resource URL
      // This would normally throw an error in default validation, but should be skipped
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://different-resource.example.com/mcp-server", // Mismatched resource
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods
      (providerWithCustomValidation.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (providerWithCustomValidation.tokens as jest.Mock).mockResolvedValue(undefined);
      (providerWithCustomValidation.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (providerWithCustomValidation.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Call auth - should succeed despite resource mismatch because custom validation overrides default
      const result = await auth(providerWithCustomValidation, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("REDIRECT");

      // Verify custom validation method was called
      expect(mockValidateResourceURL).toHaveBeenCalledWith(
        new URL("https://api.example.com/mcp-server"),
        "https://different-resource.example.com/mcp-server"
      );
    });

    it("uses prefix of server URL from PRM resource as resource parameter", async () => {
      // Mock successful metadata discovery with resource URL that is a prefix of requested URL
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              // Resource is a prefix of the requested server URL
              resource: "https://api.example.com/",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Call auth with a URL that has the resource as prefix
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server/endpoint",
      });

      expect(result).toBe("REDIRECT");

      // Verify the authorization URL includes the resource parameter from PRM
      expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );

      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl: URL = redirectCall[0];
      // Should use the PRM's resource value, not the full requested URL
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/");
    });

    it("excludes resource parameter when Protected Resource Metadata is not present", async () => {
      // Mock metadata discovery where protected resource metadata is not available (404)
      // but authorization server metadata is available
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata not available
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Call auth - should not include resource parameter
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("REDIRECT");

      // Verify the authorization URL does NOT include the resource parameter
      expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );

      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl: URL = redirectCall[0];
      // Resource parameter should not be present when PRM is not available
      expect(authUrl.searchParams.has("resource")).toBe(false);
    });

    it("excludes resource parameter in token exchange when Protected Resource Metadata is not present", async () => {
      // Mock metadata discovery - no protected resource metadata, but auth server metadata available
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (urlString.includes("/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "access123",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh123",
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token exchange
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.codeVerifier as jest.Mock).mockResolvedValue("test-verifier");
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with authorization code
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        authorizationCode: "auth-code-123",
      });

      expect(result).toBe("AUTHORIZED");

      // Find the token exchange call
      const tokenCall = mockFetch.mock.calls.find(call =>
        call[0].toString().includes("/token")
      );
      expect(tokenCall).toBeDefined();

      const body = tokenCall![1].body as URLSearchParams;
      // Resource parameter should not be present when PRM is not available
      expect(body.has("resource")).toBe(false);
      expect(body.get("code")).toBe("auth-code-123");
    });

    it("excludes resource parameter in token refresh when Protected Resource Metadata is not present", async () => {
      // Mock metadata discovery - no protected resource metadata, but auth server metadata available
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();

        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://auth.example.com",
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (urlString.includes("/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "new-access123",
              token_type: "Bearer",
              expires_in: 3600,
            }),
          });
        }

        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token refresh
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue({
        access_token: "old-access",
        refresh_token: "refresh123",
      });
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with existing tokens (should trigger refresh)
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("AUTHORIZED");

      // Find the token refresh call
      const tokenCall = mockFetch.mock.calls.find(call =>
        call[0].toString().includes("/token")
      );
      expect(tokenCall).toBeDefined();

      const body = tokenCall![1].body as URLSearchParams;
      // Resource parameter should not be present when PRM is not available
      expect(body.has("resource")).toBe(false);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh123");
    });
  });
});
