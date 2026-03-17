# OAuth Without Dynamic Client Registration (DCR) Example

Many OAuth providers (GitHub, Google, Azure AD, etc.) do not support [RFC 7591 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591). This example demonstrates how to build an MCP server that authenticates users through such a provider using a **proxy
pattern**.

## The problem

The MCP specification's OAuth flow expects an Authorization Server that supports DCR. When connecting to a provider that only accepts pre-registered OAuth apps, MCP clients cannot complete the standard registration step.

## The solution: OAuth proxy

The MCP server runs a lightweight OAuth Authorization Server that sits between the MCP client and the upstream provider:

```
MCP Client  <-->  OAuth Proxy (this server)  <-->  Upstream Provider (GitHub)
                  - Accepts DCR from clients        - No DCR support
                  - Proxies auth to upstream         - Pre-registered OAuth app
                  - Issues its own tokens            - Issues upstream tokens
```

The proxy:

1. **Accepts DCR** from MCP clients (issuing proxy-level client credentials)
2. **Redirects authorization** to the upstream provider using pre-registered credentials
3. **Exchanges upstream tokens** and issues its own tokens to MCP clients
4. **Maps proxy tokens to upstream tokens** so the MCP server can call upstream APIs on behalf of the user

## Setup

### 1. Register an OAuth app with the upstream provider

For GitHub:

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Set the **Authorization callback URL** to `http://localhost:3001/callback`
4. Note the **Client ID** and generate a **Client Secret**

### 2. Set environment variables

```bash
export OAUTH_CLIENT_ID="your-github-client-id"
export OAUTH_CLIENT_SECRET="your-github-client-secret"
```

### 3. Run the server

From the SDK root:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/oauthWithoutDCR.ts
```

Or from within this package:

```bash
pnpm tsx src/oauthWithoutDCR.ts
```

### 4. Connect a client

Use the example OAuth client:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleOAuthClient.ts
```

## Configuration

| Variable              | Default                                       | Description                          |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| `OAUTH_CLIENT_ID`     | (required)                                    | Client ID from upstream provider     |
| `OAUTH_CLIENT_SECRET` | (required)                                    | Client secret from upstream provider |
| `MCP_PORT`            | `3000`                                        | Port for the MCP server              |
| `PROXY_PORT`          | `3001`                                        | Port for the OAuth proxy server      |
| `OAUTH_AUTHORIZE_URL` | `https://github.com/login/oauth/authorize`    | Upstream authorization endpoint      |
| `OAUTH_TOKEN_URL`     | `https://github.com/login/oauth/access_token` | Upstream token endpoint              |
| `OAUTH_SCOPES`        | `read:user user:email`                        | Space-separated scopes for upstream  |

## Adapting to other providers

To use Google instead of GitHub, set:

```bash
export OAUTH_AUTHORIZE_URL="https://accounts.google.com/o/oauth2/v2/auth"
export OAUTH_TOKEN_URL="https://oauth2.googleapis.com/token"
export OAUTH_SCOPES="openid email profile"
```

The proxy pattern works with any standard OAuth 2.0 provider. The only requirement is that you pre-register an OAuth application and provide the credentials via environment variables.

## Security considerations

This example is for **demonstration purposes**. For production use:

- Use HTTPS for all endpoints
- Persist client registrations and tokens in a database (not in-memory)
- Implement proper PKCE validation end-to-end
- Implement token refresh and revocation
- Restrict CORS origins
- Add rate limiting to the registration and token endpoints
- Validate redirect URIs strictly (exact match, no open redirects)
- Set appropriate token expiration times
- Consider adding CSRF protection to the authorization flow
