import { Request, Response } from "express";
import { requireBearerAuth } from "./bearerAuth.js";
import { AuthInfo } from "../types.js";
import { InsufficientScopeError, InvalidTokenError, OAuthError, ServerError } from "../errors.js";
import { OAuthServerProvider } from "../provider.js";
import { OAuthRegisteredClientsStore } from "../clients.js";

// Mock provider
const mockVerifyAccessToken = jest.fn();
const mockProvider: OAuthServerProvider = {
  clientsStore: {} as OAuthRegisteredClientsStore,
  authorize: jest.fn(),
  challengeForAuthorizationCode: jest.fn(),
  exchangeAuthorizationCode: jest.fn(),
  exchangeRefreshToken: jest.fn(),
  verifyAccessToken: mockVerifyAccessToken,
};

describe("requireBearerAuth middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: jest.Mock;

  beforeEach(() => {
    mockRequest = {
      headers: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      set: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  })

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should call next when token is valid", async () => {
    const validAuthInfo: AuthInfo = {
      token: "valid-token",
      clientId: "client-123",
      scopes: ["read", "write"],
    };
    mockVerifyAccessToken.mockResolvedValue(validAuthInfo);

    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockRequest.auth).toEqual(validAuthInfo);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
    expect(mockResponse.json).not.toHaveBeenCalled();
  });
  
  it("should reject expired tokens", async () => {
    const expiredAuthInfo: AuthInfo = {
      token: "expired-token",
      clientId: "client-123",
      scopes: ["read", "write"],
      expiresAt: Math.floor(Date.now() / 1000) - 100, // Token expired 100 seconds ago
    };
    mockVerifyAccessToken.mockResolvedValue(expiredAuthInfo);

    mockRequest.headers = {
      authorization: "Bearer expired-token",
    };

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("expired-token");
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="invalid_token"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_token", error_description: "Token has expired" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });
  
  it("should accept non-expired tokens", async () => {
    const nonExpiredAuthInfo: AuthInfo = {
      token: "valid-token",
      clientId: "client-123",
      scopes: ["read", "write"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // Token expires in an hour
    };
    mockVerifyAccessToken.mockResolvedValue(nonExpiredAuthInfo);

    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockRequest.auth).toEqual(nonExpiredAuthInfo);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
    expect(mockResponse.json).not.toHaveBeenCalled();
  });

  it("should require specific scopes when configured", async () => {
    const authInfo: AuthInfo = {
      token: "valid-token",
      clientId: "client-123",
      scopes: ["read"],
    };
    mockVerifyAccessToken.mockResolvedValue(authInfo);

    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    const middleware = requireBearerAuth({
      provider: mockProvider,
      requiredScopes: ["read", "write"]
    });

    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="insufficient_scope"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "insufficient_scope", error_description: "Insufficient scope" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should accept token with all required scopes", async () => {
    const authInfo: AuthInfo = {
      token: "valid-token",
      clientId: "client-123",
      scopes: ["read", "write", "admin"],
    };
    mockVerifyAccessToken.mockResolvedValue(authInfo);

    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    const middleware = requireBearerAuth({
      provider: mockProvider,
      requiredScopes: ["read", "write"]
    });

    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockRequest.auth).toEqual(authInfo);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
    expect(mockResponse.json).not.toHaveBeenCalled();
  });

  it("should return 401 when no Authorization header is present", async () => {
    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="invalid_token"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_token", error_description: "Missing Authorization header" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 401 when Authorization header format is invalid", async () => {
    mockRequest.headers = {
      authorization: "InvalidFormat",
    };

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="invalid_token"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "invalid_token",
        error_description: "Invalid Authorization header format, expected 'Bearer TOKEN'"
      })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 401 when token verification fails with InvalidTokenError", async () => {
    mockRequest.headers = {
      authorization: "Bearer invalid-token",
    };

    mockVerifyAccessToken.mockRejectedValue(new InvalidTokenError("Token expired"));

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("invalid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(401);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="invalid_token"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_token", error_description: "Token expired" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 403 when access token has insufficient scopes", async () => {
    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    mockVerifyAccessToken.mockRejectedValue(new InsufficientScopeError("Required scopes: read, write"));

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(mockResponse.set).toHaveBeenCalledWith(
      "WWW-Authenticate",
      expect.stringContaining('Bearer error="insufficient_scope"')
    );
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "insufficient_scope", error_description: "Required scopes: read, write" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 500 when a ServerError occurs", async () => {
    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    mockVerifyAccessToken.mockRejectedValue(new ServerError("Internal server issue"));

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "server_error", error_description: "Internal server issue" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 400 for generic OAuthError", async () => {
    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    mockVerifyAccessToken.mockRejectedValue(new OAuthError("custom_error", "Some OAuth error"));

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "custom_error", error_description: "Some OAuth error" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it("should return 500 when unexpected error occurs", async () => {
    mockRequest.headers = {
      authorization: "Bearer valid-token",
    };

    mockVerifyAccessToken.mockRejectedValue(new Error("Unexpected error"));

    const middleware = requireBearerAuth({ provider: mockProvider });
    await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

    expect(mockVerifyAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "server_error", error_description: "Internal Server Error" })
    );
    expect(nextFunction).not.toHaveBeenCalled();
  });

  describe("with resourceMetadataUrl", () => {
    const resourceMetadataUrl = "https://api.example.com/.well-known/oauth-protected-resource";

    it("should include resource_metadata in WWW-Authenticate header for 401 responses", async () => {
      mockRequest.headers = {};

      const middleware = requireBearerAuth({ provider: mockProvider, resourceMetadataUrl });
      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${resourceMetadataUrl}"`
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should include resource_metadata in WWW-Authenticate header when token verification fails", async () => {
      mockRequest.headers = {
        authorization: "Bearer invalid-token",
      };

      mockVerifyAccessToken.mockRejectedValue(new InvalidTokenError("Token expired"));

      const middleware = requireBearerAuth({ provider: mockProvider, resourceMetadataUrl });
      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="Token expired", resource_metadata="${resourceMetadataUrl}"`
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should include resource_metadata in WWW-Authenticate header for insufficient scope errors", async () => {
      mockRequest.headers = {
        authorization: "Bearer valid-token",
      };

      mockVerifyAccessToken.mockRejectedValue(new InsufficientScopeError("Required scopes: admin"));

      const middleware = requireBearerAuth({ provider: mockProvider, resourceMetadataUrl });
      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", error_description="Required scopes: admin", resource_metadata="${resourceMetadataUrl}"`
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should include resource_metadata when token is expired", async () => {
      const expiredAuthInfo: AuthInfo = {
        token: "expired-token",
        clientId: "client-123",
        scopes: ["read", "write"],
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      };
      mockVerifyAccessToken.mockResolvedValue(expiredAuthInfo);

      mockRequest.headers = {
        authorization: "Bearer expired-token",
      };

      const middleware = requireBearerAuth({ provider: mockProvider, resourceMetadataUrl });
      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        `Bearer error="invalid_token", error_description="Token has expired", resource_metadata="${resourceMetadataUrl}"`
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should include resource_metadata when scope check fails", async () => {
      const authInfo: AuthInfo = {
        token: "valid-token",
        clientId: "client-123",
        scopes: ["read"],
      };
      mockVerifyAccessToken.mockResolvedValue(authInfo);

      mockRequest.headers = {
        authorization: "Bearer valid-token",
      };

      const middleware = requireBearerAuth({
        provider: mockProvider,
        requiredScopes: ["read", "write"],
        resourceMetadataUrl
      });

      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.set).toHaveBeenCalledWith(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", error_description="Insufficient scope", resource_metadata="${resourceMetadataUrl}"`
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should not affect server errors (no WWW-Authenticate header)", async () => {
      mockRequest.headers = {
        authorization: "Bearer valid-token",
      };

      mockVerifyAccessToken.mockRejectedValue(new ServerError("Internal server issue"));

      const middleware = requireBearerAuth({ provider: mockProvider, resourceMetadataUrl });
      await middleware(mockRequest as Request, mockResponse as Response, nextFunction);

      expect(mockResponse.status).toHaveBeenCalledWith(500);
      expect(mockResponse.set).not.toHaveBeenCalledWith("WWW-Authenticate", expect.anything());
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });
});