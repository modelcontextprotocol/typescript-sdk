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

    // Protocol Version Propagation Tests
    it("includes MCP-Protocol-Version header when protocolVersion specified", async () => {
      const customProtocolVersion = "2024-11-05";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com", {
        protocolVersion: customProtocolVersion,
      });
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify exact protocol version header is used
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe("https://resource.example.com/.well-known/oauth-protected-resource");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });
    });

    it("uses default protocol version when protocolVersion not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com");
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify default protocol version header is used
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe("https://resource.example.com/.well-known/oauth-protected-resource");
      expect(options.headers).toHaveProperty("MCP-Protocol-Version");
      expect(options.headers["MCP-Protocol-Version"]).toBe("2025-03-26"); // current LATEST_PROTOCOL_VERSION
    });

    // Custom Resource Metadata URL Tests
    it("uses custom resourceMetadataUrl when provided", async () => {
      const customMetadataUrl = "https://metadata.different.com/custom-endpoint";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com", {
        resourceMetadataUrl: customMetadataUrl,
      });
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify custom URL is used, not default well-known
      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe(customMetadataUrl);
    });

    it("uses custom resourceMetadataUrl with protocol version headers", async () => {
      const customMetadataUrl = "https://metadata.different.com/custom-endpoint";
      const customProtocolVersion = "2024-11-05";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com", {
        resourceMetadataUrl: customMetadataUrl,
        protocolVersion: customProtocolVersion,
      });
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify both custom URL and protocol version are correctly applied
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe(customMetadataUrl);
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });
    });

    it("handles CORS fallback with custom protocol version", async () => {
      const customProtocolVersion = "2024-11-05";
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call with MCP header - fail with TypeError (simulating CORS error)
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
      const metadata = await discoverOAuthProtectedResourceMetadata("https://resource.example.com", {
        protocolVersion: customProtocolVersion,
      });
      expect(metadata).toEqual(validMetadata);

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify first call had custom protocol version header
      expect(mockFetch.mock.calls[0][1]?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify second call had no headers (CORS fallback)
      expect(mockFetch.mock.calls[1][1]).toBeUndefined();
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

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      expect(metadata).toEqual(validMetadata);
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBe(1);
      const [url, options] = calls[0];
      expect(url.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": "2025-03-26"
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

    // Protocol Version Propagation Tests for OAuth Metadata Discovery
    it("includes MCP-Protocol-Version header when protocolVersion specified", async () => {
      const customProtocolVersion = "2024-11-05";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com", {
        protocolVersion: customProtocolVersion,
      });
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify exact protocol version header is used
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });
    });

    it("uses default protocol version when protocolVersion not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validMetadata,
      });

      const metadata = await discoverOAuthMetadata("https://auth.example.com");
      
      expect(metadata).toEqual(validMetadata);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      // Verify default protocol version header is used (consistent with existing tests)
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toBe("https://auth.example.com/.well-known/oauth-authorization-server");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": "2025-03-26"  // current LATEST_PROTOCOL_VERSION
      });
    });

    it("handles CORS fallback with custom protocol version for OAuth metadata", async () => {
      const customProtocolVersion = "2024-11-05";
      let callCount = 0;

      // Mock implementation that changes behavior based on call count
      mockFetch.mockImplementation((_url, _options) => {
        callCount++;

        if (callCount === 1) {
          // First call with MCP header - fail with TypeError (simulating CORS error)
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
      const metadata = await discoverOAuthMetadata("https://auth.example.com", {
        protocolVersion: customProtocolVersion,
      });
      expect(metadata).toEqual(validMetadata);

      // Verify both calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify first call had custom protocol version header
      expect(mockFetch.mock.calls[0][1]?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify second call had no headers (CORS fallback)
      expect(mockFetch.mock.calls[1][1]).toBeUndefined();
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
      expect(codeVerifier).toBe("test_verifier");
    });

    it("includes resource parameter when provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
          resource: new URL("https://api.example.com/mcp-server"),
        }
      );

      expect(authorizationUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("excludes resource parameter when not provided", async () => {
      const { authorizationUrl } = await startAuthorization(
        "https://auth.example.com",
        {
          clientInformation: validClientInfo,
          redirectUrl: "http://localhost:3000/callback",
        }
      );

      expect(authorizationUrl.searchParams.has("resource")).toBe(false);
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
    });

    it("includes resource parameter in token exchange when provided", async () => {
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
      
      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("excludes resource parameter from token exchange when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokens,
      });

      await exchangeAuthorization("https://auth.example.com", {
        clientInformation: validClientInfo,
        authorizationCode: "code123",
        codeVerifier: "verifier123",
        redirectUri: "http://localhost:3000/callback",
      });

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.has("resource")).toBe(false);
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
    });

    it("includes resource parameter in refresh token request when provided", async () => {
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
      
      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("excludes resource parameter from refresh token request when not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => validTokensWithNewRefreshToken,
      });

      await refreshAuthorization("https://auth.example.com", {
        clientInformation: validClientInfo,
        refreshToken: "refresh123",
      });

      const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
      expect(body.has("resource")).toBe(false);
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
        } else if (callCount === 2 && urlString.includes("/.well-known/oauth-authorization-server")) {
          // Second call - auth server metadata succeeds
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
        } else if (callCount === 3 && urlString.includes("/register")) {
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
        serverUrl: "https://resource.example.com",
      });

      // Verify the result
      expect(result).toBe("REDIRECT");

      // Verify the sequence of calls
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // First call should be to protected resource metadata
      expect(mockFetch.mock.calls[0][0].toString()).toBe(
        "https://resource.example.com/.well-known/oauth-protected-resource"
      );

      // Second call should be to oauth metadata
      expect(mockFetch.mock.calls[1][0].toString()).toBe(
        "https://resource.example.com/.well-known/oauth-authorization-server"
      );
    });

    it("canonicalizes resource URI by removing fragment", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

      // Call the auth function with a resource that has a fragment
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server#fragment",
      });

      expect(result).toBe("REDIRECT");

      // Verify redirectToAuthorization was called with the canonicalized resource
      expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          searchParams: expect.any(URLSearchParams),
        })
      );

      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("passes resource parameter through authorization flow", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("includes resource in token exchange when authorization code is provided", async () => {
      // Mock successful metadata discovery and token exchange
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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
      // Mock successful metadata discovery and token refresh
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

    it("handles derived resource parameter from serverUrl", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

      // Call auth with just serverUrl (resource is derived from it)
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
      });

      expect(result).toBe("REDIRECT");

      // Verify that resource parameter is always included (derived from serverUrl)
      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.has("resource")).toBe(true);
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("handles resource with multiple fragments", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

      // Call auth with resource containing multiple # symbols
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server#fragment#another",
      });

      expect(result).toBe("REDIRECT");

      // Verify the resource is properly canonicalized (everything after first # removed)
      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
    });

    it("verifies resource parameter distinguishes between different paths on same domain", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

      // Test with different resource paths on same domain
      // This tests the security fix that prevents token confusion between
      // multiple MCP servers on the same domain
      const result1 = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server-1/v1",
      });

      expect(result1).toBe("REDIRECT");

      const redirectCall1 = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl1: URL = redirectCall1[0];
      expect(authUrl1.searchParams.get("resource")).toBe("https://api.example.com/mcp-server-1/v1");

      // Clear mock calls
      (mockProvider.redirectToAuthorization as jest.Mock).mockClear();

      // Test with different path on same domain
      const result2 = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server-2/v1",
      });

      expect(result2).toBe("REDIRECT");

      const redirectCall2 = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl2: URL = redirectCall2[0];
      expect(authUrl2.searchParams.get("resource")).toBe("https://api.example.com/mcp-server-2/v1");
      
      // Verify that the two resources are different (critical for security)
      expect(authUrl1.searchParams.get("resource")).not.toBe(authUrl2.searchParams.get("resource"));
    });

    it("preserves query parameters in resource URI", async () => {
      // Mock successful metadata discovery
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        if (urlString.includes("/.well-known/oauth-authorization-server")) {
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

      // Call auth with resource containing query parameters
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server?param=value&another=test",
      });

      expect(result).toBe("REDIRECT");

      // Verify query parameters are preserved (only fragment is removed)
      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server?param=value&another=test");
    });

    describe("resource matching validation (RFC 9728)", () => {
      // Setup common mocks for resource validation tests
      beforeEach(() => {
        // Mock provider methods for all resource validation tests
        (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
          client_id: "test-client",
          client_secret: "test-secret",
        });
        (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);
      });

      it("accepts when protected resource metadata returns matching resource", async () => {
        // Mock console.warn to verify no warnings are logged
        const originalWarn = console.warn;
        const mockWarn = jest.fn();
        console.warn = mockWarn;

        mockFetch.mockImplementation((url) => {
          const urlString = url.toString();
          if (urlString.includes("/.well-known/oauth-protected-resource")) {
            // Protected resource metadata returns EXACT match
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

        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server",
        });

        expect(result).toBe("REDIRECT");

        // Verify NO fallback warning was logged (resource matched)
        expect(mockWarn).not.toHaveBeenCalled();

        // Restore console.warn
        console.warn = originalWarn;
      });

      it("throws error when protected resource metadata returns different resource", async () => {
        // Mock console.warn to verify fallback behavior
        const originalWarn = console.warn;
        const mockWarn = jest.fn();
        console.warn = mockWarn;

        let callCount = 0;
        mockFetch.mockImplementation((url) => {
          callCount++;
          const urlString = url.toString();

          if (callCount === 1 && urlString.includes("/.well-known/oauth-protected-resource")) {
            // First call: Protected resource metadata returns WRONG resource
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                resource: "https://WRONG.example.com/different-server", // MISMATCH
                authorization_servers: ["https://malicious.example.com"],
              }),
            });
          } else if (callCount === 2 && urlString.includes("/.well-known/oauth-authorization-server")) {
            // Second call: Traditional discovery method
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

        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server",
        });

        expect(result).toBe("REDIRECT");
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Verify warning was logged about resource mismatch
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining("Could not load OAuth Protected Resource metadata"),
          expect.any(Error)
        );

        // Verify the error message specifically mentions resource mismatch
        const errorArg = mockWarn.mock.calls[0][1];
        expect(errorArg.message).toContain("doesn't match the expected resource");

        // Restore console.warn
        console.warn = originalWarn;
      });

      it("throws error when protected resource metadata is missing resource field", async () => {
        // Mock console.warn to verify fallback behavior
        const originalWarn = console.warn;
        const mockWarn = jest.fn();
        console.warn = mockWarn;

        let callCount = 0;
        mockFetch.mockImplementation((url) => {
          callCount++;
          const urlString = url.toString();

          if (callCount === 1 && urlString.includes("/.well-known/oauth-protected-resource")) {
            // First call: Protected resource metadata missing resource field
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                // Missing resource field entirely
                authorization_servers: ["https://auth.example.com"],
              }),
            });
          } else if (callCount === 2 && urlString.includes("/.well-known/oauth-authorization-server")) {
            // Second call: Traditional discovery method
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

        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server",
        });

        expect(result).toBe("REDIRECT");
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Verify warning was logged
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining("Could not load OAuth Protected Resource metadata"),
          expect.any(Error)
        );

        // Restore console.warn
        console.warn = originalWarn;
      });

      it("compares resources after fragment removal", async () => {
        mockFetch.mockImplementation((url) => {
          const urlString = url.toString();
          if (urlString.includes("/.well-known/oauth-protected-resource")) {
            // Server returns canonical resource (no fragment)
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                resource: "https://api.example.com/mcp-server", // No fragment
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

        // Client requests with fragment - should be canonicalized
        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server#some-fragment",
        });

        expect(result).toBe("REDIRECT");

        // Verify resource was canonicalized in authorization URL
        const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
        const authUrl = redirectCall[0] as URL;
        expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
      });
    });

    // Protocol Version Propagation Tests for main auth function
    it("propagates protocolVersion through entire auth flow", async () => {
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls to verify protocol version is passed correctly
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata succeeds with matching resource
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://custom-auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://custom-auth.example.com",
              authorization_endpoint: "https://custom-auth.example.com/authorize",
              token_endpoint: "https://custom-auth.example.com/token",
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

      // Call auth with protocolVersion
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("REDIRECT");

      // Verify protocol version was included in all metadata discovery calls
      const protectedResourceCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-protected-resource")
      );
      expect(protectedResourceCall).toBeDefined();
      expect(protectedResourceCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Auth server metadata discovery should NOT inherit the protocol version automatically
      // since it's called with the authorizationServerUrl, not the original serverUrl
      const authServerCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-authorization-server")
      );
      expect(authServerCall).toBeDefined();
      // This should use default protocol version since auth metadata discovery 
      // doesn't currently accept protocolVersion parameter
      expect(authServerCall?.headers).toEqual({
        "MCP-Protocol-Version": "2025-03-26"  // default version
      });
    });

    it("propagates protocolVersion correctly when protected resource metadata fails", async () => {
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata fails
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata fallback succeeds
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

      // Call auth with protocolVersion
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("REDIRECT");

      // Verify protocol version was used in protected resource call
      const protectedResourceCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-protected-resource")
      );
      expect(protectedResourceCall).toBeDefined();
      expect(protectedResourceCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });
    });

    // Custom Resource Metadata URL Tests for main auth function
    it("respects custom resourceMetadataUrl throughout auth flow", async () => {
      const customMetadataUrl = "https://metadata.different.com/custom-oauth-protected-resource";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom metadata URL returns alternative auth server
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://alternative-auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata for the alternative server
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://alternative-auth.example.com",
              authorization_endpoint: "https://alternative-auth.example.com/authorize",
              token_endpoint: "https://alternative-auth.example.com/token",
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

      // Call auth with custom resourceMetadataUrl
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
      });

      expect(result).toBe("REDIRECT");

      // Verify custom metadata URL was used, not default well-known
      const customUrlCall = fetchCalls.find(call => call.url === customMetadataUrl);
      expect(customUrlCall).toBeDefined();

      // Verify NO call was made to the default protected resource metadata URL
      const defaultProtectedResourceCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-protected-resource") && 
        call.url !== customMetadataUrl
      );
      expect(defaultProtectedResourceCall).toBeUndefined();

      // Verify the alternative auth server was used
      const altAuthServerCall = fetchCalls.find(call => 
        call.url.includes("alternative-auth.example.com")
      );
      expect(altAuthServerCall).toBeDefined();
    });

    it("handles custom resourceMetadataUrl with protocol version correctly", async () => {
      const customMetadataUrl = "https://metadata.different.com/custom-oauth-protected-resource";
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom metadata URL succeeds
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata
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

      // Call auth with both custom resourceMetadataUrl and protocolVersion
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("REDIRECT");

      // Verify both custom URL and protocol version were used correctly together
      const customUrlCall = fetchCalls.find(call => call.url === customMetadataUrl);
      expect(customUrlCall).toBeDefined();
      expect(customUrlCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });
    });

    // Resource Validation Tests with new parameters
    it("validates resource matching even with protocol version headers", async () => {
      const customProtocolVersion = "2024-11-05";
      
      // Mock console.warn to verify fallback behavior
      const originalWarn = console.warn;
      const mockWarn = jest.fn();
      console.warn = mockWarn;

      mockFetch.mockImplementation((url, _options) => {
        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata returns MISMATCHED resource
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://WRONG.example.com/different-server",  // This doesn't match expected
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Fallback to auth server metadata succeeds
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

      // Call auth with protocolVersion - should fall back due to resource mismatch
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        protocolVersion: customProtocolVersion,
      });

      // Should succeed via fallback (not throw)
      expect(result).toBe("REDIRECT");

      // Verify the request was made with protocol version header
      const [url, options] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain("/.well-known/oauth-protected-resource");
      expect(options.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify warning was logged about resource mismatch
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("Could not load OAuth Protected Resource metadata"),
        expect.any(Error)
      );

      // Restore console.warn
      console.warn = originalWarn;
    });

    it("validates resource when using custom metadata URL", async () => {
      const customMetadataUrl = "https://metadata.different.com/custom-endpoint";
      
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom URL returns correct resource
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",  // This matches expected
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

      // Should succeed with correct resource
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
      });

      expect(result).toBe("REDIRECT");

      // Now test with INCORRECT resource - should also fall back to auth server metadata
      // (not throw, since the error is caught and fallback is used)
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom URL returns mismatched resource
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://WRONG.example.com/different-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Fallback to auth server metadata succeeds
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

      // Mock console.warn to verify fallback behavior
      const originalWarn = console.warn;
      const mockWarn = jest.fn();
      console.warn = mockWarn;

      const result2 = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
      });

      // Should succeed via fallback (not throw)
      expect(result2).toBe("REDIRECT");

      // Verify warning was logged about resource mismatch
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining("Could not load OAuth Protected Resource metadata"),
        expect.any(Error)
      );

      // Restore console.warn
      console.warn = originalWarn;
    });

    // Error Scenario Tests
    it("handles custom metadata URL 404 gracefully with fallback", async () => {
      const customMetadataUrl = "https://metadata.different.com/not-found";
      
      mockFetch.mockImplementation((url) => {
        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom URL returns 404
          return Promise.resolve({
            ok: false,
            status: 404,
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Fallback to auth server metadata succeeds
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

      // Should complete successfully via fallback
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
      });

      expect(result).toBe("REDIRECT");

      // Verify fallback to auth server metadata was used
      const authServerCall = mockFetch.mock.calls.find(call => 
        call[0].toString().includes("/.well-known/oauth-authorization-server")
      );
      expect(authServerCall).toBeDefined();
    });

    it("handles all new parameters together correctly", async () => {
      const customMetadataUrl = "https://metadata.different.com/comprehensive";
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString === customMetadataUrl) {
          // Custom URL succeeds with complex scenario
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://complex-auth.example.com"],
              scopes_supported: ["read", "write", "admin"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              issuer: "https://complex-auth.example.com",
              authorization_endpoint: "https://complex-auth.example.com/authorize",
              token_endpoint: "https://complex-auth.example.com/token",
              registration_endpoint: "https://complex-auth.example.com/register",
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            }),
          });
        } else if (urlString.includes("/register")) {
          // Dynamic client registration
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              client_id: "dynamic-client-id",
              client_secret: "dynamic-client-secret",
              client_id_issued_at: 1612137600,
              client_secret_expires_at: 1612224000,
              redirect_uris: ["http://localhost:3000/callback"],
              client_name: "Test Client",
            }),
          });
        }
        
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for full flow with dynamic registration
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue(undefined); // Trigger dynamic registration
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      mockProvider.saveClientInformation = jest.fn();
      (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Call auth with ALL new parameters
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
        protocolVersion: customProtocolVersion,
        scope: "read write admin",
      });

      expect(result).toBe("REDIRECT");

      // Verify complex parameter interaction
      const customUrlCall = fetchCalls.find(call => call.url === customMetadataUrl);
      expect(customUrlCall).toBeDefined();
      expect(customUrlCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify flow completed with alternative auth server
      const complexAuthCall = fetchCalls.find(call => 
        call.url.includes("complex-auth.example.com")
      );
      expect(complexAuthCall).toBeDefined();

      // Verify final authorization includes scope and resource
      const redirectCall = (mockProvider.redirectToAuthorization as jest.Mock).mock.calls[0];
      const authUrl = redirectCall[0] as URL;
      expect(authUrl.searchParams.get("resource")).toBe("https://api.example.com/mcp-server");
      expect(authUrl.searchParams.get("scope")).toBe("read write admin");
    });

    // Edge Case Tests - Protocol Version Validation
    it("handles edge case protocol versions correctly", async () => {
      const edgeCaseVersions = [
        "1999-01-01",  // Very old date
        "2099-12-31",  // Future date
        "2024-11-05-draft", // With suffix
        ""  // Empty string
      ];

      for (const version of edgeCaseVersions) {
        mockFetch.mockImplementation((url, _options) => {
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

        // Mock provider methods
        (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
          client_id: "test-client",
          client_secret: "test-secret",
        });
        (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

        // Should handle edge case versions without crashing
        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server",
          protocolVersion: version,
        });

        expect(result).toBe("REDIRECT");

        // Verify the edge case version was passed through correctly
        const [url, options] = mockFetch.mock.calls[mockFetch.mock.calls.length - 2]; // -2 because last is auth server metadata
        expect(url.toString()).toContain("/.well-known/oauth-protected-resource");
        expect(options.headers).toEqual({
          "MCP-Protocol-Version": version
        });

        // Reset mocks for next iteration
        mockFetch.mockReset();
      }
    });

    // Edge Case Tests - Custom Resource Metadata URL Validation
    it("handles various custom URL formats correctly", async () => {
      const customUrls = [
        "https://metadata.example.com:8443/custom/path",  // With port
        "https://metadata.example.com/path/with/query?param=value", // With query params
        "https://metadata.example.com/path#fragment", // With fragment (should work since we use it as-is)
        "http://localhost:3000/metadata", // Localhost with http
      ];

      for (const customUrl of customUrls) {
        mockFetch.mockImplementation((url, _options) => {
          const urlString = url.toString();
          if (urlString === customUrl) {
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

        // Mock provider methods
        (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
          client_id: "test-client",
          client_secret: "test-secret",
        });
        (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
        (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

        // Should handle various URL formats without crashing
        const result = await auth(mockProvider, {
          serverUrl: "https://api.example.com/mcp-server",
          resourceMetadataUrl: new URL(customUrl),
        });

        expect(result).toBe("REDIRECT");

        // Verify the exact custom URL was used
        const customUrlCall = mockFetch.mock.calls.find(call => call[0].toString() === customUrl);
        expect(customUrlCall).toBeDefined();

        // Reset mocks for next iteration
        mockFetch.mockReset();
      }
    });

    // Comprehensive Token Exchange Test with Protocol Version
    it("propagates protocolVersion to protected resource metadata in token exchange flow", async () => {
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata succeeds
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata
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
          // Token exchange endpoint
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "new-access-token",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "new-refresh-token",
            }),
          });
        }
        
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token exchange flow
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.codeVerifier as jest.Mock).mockResolvedValue("test-verifier");
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with authorizationCode to trigger token exchange
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        authorizationCode: "auth-code-123",
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("AUTHORIZED");

      // Verify protocol version was used in protected resource metadata call
      const protectedResourceCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-protected-resource")
      );
      expect(protectedResourceCall).toBeDefined();
      expect(protectedResourceCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify token exchange was called with correct resource parameter
      const tokenCall = fetchCalls.find(call => call.url.includes("/token"));
      expect(tokenCall).toBeDefined();
      // We would check body here but that requires accessing the mock call details
    });

    // Token Refresh Test with Protocol Version
    it("propagates protocolVersion to protected resource metadata in token refresh flow", async () => {
      const customProtocolVersion = "2024-11-05";
      
      // Track all fetch calls
      const fetchCalls: Array<{ url: string, headers: any }> = [];
      
      mockFetch.mockImplementation((url, options) => {
        fetchCalls.push({
          url: url.toString(),
          headers: options?.headers || {}
        });

        const urlString = url.toString();
        
        if (urlString.includes("/.well-known/oauth-protected-resource")) {
          // Protected resource metadata succeeds
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              resource: "https://api.example.com/mcp-server",
              authorization_servers: ["https://auth.example.com"],
            }),
          });
        } else if (urlString.includes("/.well-known/oauth-authorization-server")) {
          // Auth server metadata
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
          // Token refresh endpoint
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "refreshed-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
          });
        }
        
        return Promise.resolve({ ok: false, status: 404 });
      });

      // Mock provider methods for token refresh flow
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue({
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
      });
      (mockProvider.saveTokens as jest.Mock).mockResolvedValue(undefined);

      // Call auth with existing refresh token to trigger refresh flow
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("AUTHORIZED");

      // Verify protocol version was used in protected resource metadata call
      const protectedResourceCall = fetchCalls.find(call => 
        call.url.includes("/.well-known/oauth-protected-resource")
      );
      expect(protectedResourceCall).toBeDefined();
      expect(protectedResourceCall?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      // Verify token refresh was called
      const tokenCall = fetchCalls.find(call => call.url.includes("/token"));
      expect(tokenCall).toBeDefined();
    });

    // CORS Fallback with Combined Parameters
    it("handles CORS fallback with both custom URL and protocol version", async () => {
      const customMetadataUrl = "https://metadata.different.com/cors-test";
      const customProtocolVersion = "2024-11-05";
      let callCount = 0;

      mockFetch.mockImplementation((_url, _options) => {
        callCount++;
        const urlString = _url.toString();

        if (callCount === 1 && urlString === customMetadataUrl) {
          // First call with both custom URL and protocol version - fail with CORS error
          return Promise.reject(new TypeError("CORS error"));
        } else if (callCount === 2 && urlString === customMetadataUrl) {
          // Second call without headers - succeed
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

      // Mock provider methods
      (mockProvider.clientInformation as jest.Mock).mockResolvedValue({
        client_id: "test-client",
        client_secret: "test-secret",
      });
      (mockProvider.tokens as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.saveCodeVerifier as jest.Mock).mockResolvedValue(undefined);
      (mockProvider.redirectToAuthorization as jest.Mock).mockResolvedValue(undefined);

      // Should succeed via CORS fallback
      const result = await auth(mockProvider, {
        serverUrl: "https://api.example.com/mcp-server",
        resourceMetadataUrl: new URL(customMetadataUrl),
        protocolVersion: customProtocolVersion,
      });

      expect(result).toBe("REDIRECT");

      // Verify both calls were made to the same custom URL
      expect(mockFetch).toHaveBeenCalledTimes(3); // 2 for protected resource metadata (CORS retry) + 1 for auth server metadata

      // Verify first call had protocol version header, second didn't (CORS fallback)
      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall[0].toString()).toBe(customMetadataUrl);
      expect(firstCall[1]?.headers).toEqual({
        "MCP-Protocol-Version": customProtocolVersion
      });

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[0].toString()).toBe(customMetadataUrl);
      expect(secondCall[1]).toBeUndefined(); // No options = no headers
    });
  });
});
