/**
 * OAuth provider with persistent state management for redirect flows.
 *
 * This example demonstrates how to preserve OAuth discovery state across
 * browser redirects using the MCP discovery state APIs.
 *
 * @example
 * ```typescript
 * const oauthProvider = new OAuthProvider({
 *   clientId: "your-client-id",
 *   redirectUri: "http://localhost:3000/oauth/callback",
 * });
 *
 * // In your OAuth authorization flow:
 * const transport = await oauthProvider.initializeWithOAuth(client);
 * ```
 */

import { StreamableHTTPClientTransport } from "../client/index.js";

export interface OAuthProviderConfig {
  clientId: string;
  redirectUri: string;
  scope?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
}

export interface StoredOAuthState {
  resourceMetadataUrl?: string;
  scope?: string;
  timestamp: number;
}

/**
 * Manages OAuth discovery state persistence across redirects.
 *
 * When using interactive OAuth flows that involve browser redirects,
 * discovery state (like resource metadata URL and scopes) needs to
 * survive the navigation. This provider demonstrates the recommended
 * pattern using sessionStorage with proper expiry.
 */
export class OAuthProvider {
  private config: OAuthProviderConfig;
  private readonly STATE_KEY = "mcp-oauth-discovery-state";
  private readonly STATE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

  constructor(config: OAuthProviderConfig) {
    this.config = config;
  }

  /**
   * Save OAuth discovery state before redirect.
   *
   * Call this before initiating an OAuth authorization redirect to
   * ensure discovery metadata can be restored on the callback page.
   */
  public saveDiscoveryState(state: StoredOAuthState): void {
    if (typeof sessionStorage === "undefined") {
      console.warn(
        "[OAuthProvider] sessionStorage unavailable; discovery state will not persist across redirect"
      );
      return;
    }

    try {
      const stateWithTimestamp: StoredOAuthState = {
        ...state,
        timestamp: Date.now(),
      };
      sessionStorage.setItem(this.STATE_KEY, JSON.stringify(stateWithTimestamp));
    } catch (error) {
      console.error("[OAuthProvider] Failed to save discovery state:", error);
    }
  }

  /**
   * Load OAuth discovery state after redirect.
   *
   * Call this on your OAuth callback page to restore discovery
   * metadata from before the redirect.
   */
  public loadDiscoveryState(): StoredOAuthState | null {
    if (typeof sessionStorage === "undefined") {
      return null;
    }

    try {
      const stored = sessionStorage.getItem(this.STATE_KEY);
      if (!stored) return null;

      const state: StoredOAuthState = JSON.parse(stored);

      // Check expiry: state is only valid for 15 minutes
      if (Date.now() - state.timestamp > this.STATE_EXPIRY_MS) {
        sessionStorage.removeItem(this.STATE_KEY);
        return null;
      }

      return state;
    } catch (error) {
      console.error("[OAuthProvider] Failed to load discovery state:", error);
      return null;
    }
  }

  /**
   * Clear saved OAuth discovery state.
   *
   * Call this after successfully completing the OAuth flow to
   * prevent stale state from persisting.
   */
  public clearDiscoveryState(): void {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(this.STATE_KEY);
  }

  /**
   * Create a StreamableHTTPClientTransport with restored OAuth state.
   *
   * This is called after OAuth callback to recreate the transport
   * with discovery state restored from before the redirect.
   */
  public createTransportWithRestoredState(
    url: string,
    options?: {
      resourceMetadataUrl?: string;
      scope?: string;
    }
  ): StreamableHTTPClientTransport {
    const transport = new StreamableHTTPClientTransport(new URL(url), {});

    // If we have restored state, we could apply it to the transport
    // or use it to configure subsequent discovery requests
    if (options?.resourceMetadataUrl) {
      console.debug(
        "[OAuthProvider] Restored discovery state with metadata URL:",
        options.resourceMetadataUrl
      );
    }

    return transport;
  }

  /**
   * Generate an OAuth authorization URL.
   *
   * @returns Authorization URL to redirect the user to
   */
  public getAuthorizationUrl(state: string): string {
    const authEndpoint = new URL(
      this.config.authorizationEndpoint || "https://auth.example.com/authorize"
    );

    authEndpoint.searchParams.set("client_id", this.config.clientId);
    authEndpoint.searchParams.set("redirect_uri", this.config.redirectUri);
    authEndpoint.searchParams.set("response_type", "code");
    authEndpoint.searchParams.set("state", state);

    if (this.config.scope) {
      authEndpoint.searchParams.set("scope", this.config.scope);
    }

    return authEndpoint.toString();
  }
}
