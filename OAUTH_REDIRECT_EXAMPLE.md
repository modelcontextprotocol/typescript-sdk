# OAuth Redirect State Persistence Example

This example demonstrates the recommended pattern for preserving OAuth discovery state across browser redirects when implementing interactive OAuth flows with the MCP TypeScript SDK.

## Problem

When building a web application that uses OAuth for authentication, browser redirects can cause the loss of important state:

- The user clicks "Connect with OAuth"
- Your app initiates OAuth flow and redirects to the auth provider
- Auth provider redirects back to your callback endpoint
- Discovery state (resource metadata URL, scopes) is lost during navigation

## Solution

The `OAuthProvider` class uses `sessionStorage` to persist discovery state across redirects with automatic expiry.

## Usage

### 1. Authorization Page

```typescript
import { OAuthProvider } from "@modelcontextprotocol/sdk/client/providers";

export function OAuthAuthorizationPage() {
  const oauthProvider = new OAuthProvider({
    clientId: "your-client-id",
    redirectUri: "http://localhost:3000/oauth/callback",
    scope: "read write",
  });

  async function handleAuthorize() {
    // Save discovery state before redirecting
    oauthProvider.saveDiscoveryState({
      resourceMetadataUrl: "https://api.example.com/.well-known/mcp.json",
      scope: "read write",
    });

    // Generate and redirect to OAuth authorization URL
    const authUrl = oauthProvider.getAuthorizationUrl(generateState());
    window.location.href = authUrl;
  }

  return (
    <button onClick={handleAuthorize}>
      Connect MCP Server via OAuth
    </button>
  );
}
```

### 2. OAuth Callback Page

```typescript
import { Client } from "@modelcontextprotocol/sdk";
import { OAuthProvider } from "@modelcontextprotocol/sdk/client/providers";

export async function OAuthCallbackPage() {
  const oauthProvider = new OAuthProvider({
    clientId: "your-client-id",
    redirectUri: "http://localhost:3000/oauth/callback",
  });

  const client = new Client({
    name: "my-app",
    version: "1.0.0",
  });

  try {
    // Restore discovery state from before redirect
    const restoredState = oauthProvider.loadDiscoveryState();

    if (!restoredState?.resourceMetadataUrl) {
      throw new Error("Lost discovery state during OAuth redirect");
    }

    // Create transport with restored state
    const transport = oauthProvider.createTransportWithRestoredState(
      "https://api.example.com",
      {
        resourceMetadataUrl: restoredState.resourceMetadataUrl,
        scope: restoredState.scope,
      }
    );

    // Connect client
    await client.connect(transport);

    // Clear saved state after successful connection
    oauthProvider.clearDiscoveryState();

    return <ConnectedDashboard client={client} />;
  } catch (error) {
    console.error("OAuth callback failed:", error);
    return <ErrorPage error={error} />;
  }
}
```

## Key Design Principles

### 1. **Immutable State Structures**

Each discovery state includes a timestamp to prevent stale data:

```typescript
export interface StoredOAuthState {
  resourceMetadataUrl?: string;
  scope?: string;
  timestamp: number;  // Auto-managed
}
```

### 2. **Automatic Expiry**

State is only valid for 15 minutes:

```typescript
const STATE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

// Expired state is automatically cleaned up
if (Date.now() - state.timestamp > this.STATE_EXPIRY_MS) {
  sessionStorage.removeItem(this.STATE_KEY);
  return null;
}
```

### 3. **Graceful Degradation**

If `sessionStorage` is unavailable (e.g., private browsing), the provider logs a warning but continues:

```typescript
if (typeof sessionStorage === "undefined") {
  console.warn("[OAuthProvider] sessionStorage unavailable...");
  return;
}
```

### 4. **Error Handling**

All storage operations are wrapped in try-catch to prevent crashes:

```typescript
try {
  const stateWithTimestamp: StoredOAuthState = {
    ...state,
    timestamp: Date.now(),
  };
  sessionStorage.setItem(this.STATE_KEY, JSON.stringify(stateWithTimestamp));
} catch (error) {
  console.error("[OAuthProvider] Failed to save discovery state:", error);
}
```

## Testing

The provider includes comprehensive tests:

```bash
npm test -- packages/client/test/providers/oauthProvider.test.ts
```

Key test scenarios:
- ✅ Save and load valid state
- ✅ Automatic expiry of old state
- ✅ Graceful handling of missing `sessionStorage`
- ✅ Corrupt JSON recovery
- ✅ OAuth URL generation with parameters

## Security Considerations

1. **HTTPS Only**: In production, only use HTTPS to protect state in transit
2. **State Parameter**: Always use the OAuth `state` parameter to prevent CSRF attacks
3. **PKCE**: Consider adding PKCE (Proof Key for Code Exchange) for public clients
4. **Expiry**: The 15-minute expiry prevents replay attacks

## Advanced: Custom Storage Backend

To use a different storage backend (e.g., encrypted localStorage, server-side session):

```typescript
class CustomOAuthProvider extends OAuthProvider {
  private customStorage = new EncryptedStorage();

  public saveDiscoveryState(state: StoredOAuthState): void {
    // Use custom encrypted storage instead
    this.customStorage.set("mcp-oauth-state", JSON.stringify({
      ...state,
      timestamp: Date.now(),
    }));
  }

  public loadDiscoveryState(): StoredOAuthState | null {
    const stored = this.customStorage.get("mcp-oauth-state");
    if (!stored) return null;

    const state = JSON.parse(stored);
    if (Date.now() - state.timestamp > 15 * 60 * 1000) {
      this.customStorage.delete("mcp-oauth-state");
      return null;
    }
    return state;
  }
}
```

## Troubleshooting

### "sessionStorage is unavailable"

- Occurring in private/incognito mode
- Fallback: Use server-side session storage
- The provider will log a warning and continue (state won't persist)

### State expires before callback completes

- Increase `STATE_EXPIRY_MS` if your OAuth flow takes >15 minutes
- Better: Use server-side session state and PKCE

### Lost state during redirect

- Ensure you're calling `saveDiscoveryState()` before redirect
- Verify `sessionStorage` is available in your environment
- Check browser console for errors

## References

- [OAuth 2.0 Authorization Framework](https://tools.ietf.org/html/rfc6749)
- [OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [PKCE (RFC 7636)](https://tools.ietf.org/html/rfc7636)
