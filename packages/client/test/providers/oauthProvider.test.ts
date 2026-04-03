import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OAuthProvider, StoredOAuthState } from "../../src/providers/oauthProvider.js";

describe("OAuthProvider", () => {
  let provider: OAuthProvider;
  let mockSessionStorage: Record<string, string>;

  beforeEach(() => {
    provider = new OAuthProvider({
      clientId: "test-client-id",
      redirectUri: "http://localhost:3000/callback",
      scope: "read write",
    });

    mockSessionStorage = {};

    Object.defineProperty(global, "sessionStorage", {
      value: {
        getItem: (key: string) => mockSessionStorage[key] || null,
        setItem: (key: string, value: string) => {
          mockSessionStorage[key] = value;
        },
        removeItem: (key: string) => {
          delete mockSessionStorage[key];
        },
        clear: () => {
          mockSessionStorage = {};
        },
      },
      writable: true,
    });
  });

  afterEach(() => {
    delete (global as any).sessionStorage;
  });

  describe("saveDiscoveryState", () => {
    it("should save state with timestamp", () => {
      const state: StoredOAuthState = {
        resourceMetadataUrl: "http://example.com/.well-known/mcp.json",
        scope: "read write",
        timestamp: 0,
      };

      provider.saveDiscoveryState(state);

      const saved = JSON.parse(mockSessionStorage["mcp-oauth-discovery-state"]);
      expect(saved.resourceMetadataUrl).toBe(state.resourceMetadataUrl);
      expect(saved.scope).toBe(state.scope);
      expect(saved.timestamp).toBeGreaterThan(0);
    });
  });

  describe("loadDiscoveryState", () => {
    it("should load valid state", () => {
      const state: StoredOAuthState = {
        resourceMetadataUrl: "http://example.com/.well-known/mcp.json",
        scope: "read write",
        timestamp: Date.now(),
      };

      mockSessionStorage["mcp-oauth-discovery-state"] = JSON.stringify(state);

      const loaded = provider.loadDiscoveryState();
      expect(loaded).toEqual(state);
    });

    it("should return null for expired state", () => {
      const expiredState: StoredOAuthState = {
        resourceMetadataUrl: "http://example.com/.well-known/mcp.json",
        timestamp: Date.now() - 20 * 60 * 1000,
      };

      mockSessionStorage["mcp-oauth-discovery-state"] = JSON.stringify(
        expiredState
      );

      const loaded = provider.loadDiscoveryState();
      expect(loaded).toBeNull();
    });
  });

  describe("getAuthorizationUrl", () => {
    it("should generate valid OAuth URL", () => {
      const url = provider.getAuthorizationUrl("test-state-123");

      const parsed = new URL(url);
      expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/callback"
      );
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("state")).toBe("test-state-123");
      expect(parsed.searchParams.get("scope")).toBe("read write");
    });
  });
});
