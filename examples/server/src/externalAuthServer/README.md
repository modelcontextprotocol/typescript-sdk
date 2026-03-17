# External Auth Server Example

Demonstrates MCP authentication using an **external OAuth2 authorization server** separate from the MCP resource server. This follows the RFC 8707 pattern where the authorization server (AS) and resource server (RS) are independent services.

## Architecture

```
┌──────────┐         ┌────────────────────┐         ┌──────────────────────┐
│          │  1. 401 │                    │         │                      │
│  Client  │◄────────│  MCP Resource      │         │  External OAuth AS   │
│          │         │  Server (:3000)    │         │  (:3001)             │
│          │         │                    │         │                      │
│          │  2. Fetch protected resource │         │  - /authorize        │
│          │────────►│  metadata          │         │  - /token            │
│          │◄────────│  (points to AS)    │         │  - /register         │
│          │         │                    │         │  - /jwks             │
│          │  3. OAuth flow              │         │  - /.well-known/     │
│          │────────────────────────────────────────►│    oauth-authz-srv  │
│          │◄────────────────────────────────────────│                      │
│          │         │                    │         │                      │
│          │  4. MCP │                    │  5. JWT │                      │
│          │  + JWT  │                    │  verify │                      │
│          │────────►│                    │────────►│  /jwks               │
│          │◄────────│                    │◄────────│                      │
└──────────┘         └────────────────────┘         └──────────────────────┘
```

## How it works

1. Client connects to MCP server, gets a 401 with `resource_metadata` URL in the `WWW-Authenticate` header
2. Client fetches `/.well-known/oauth-protected-resource/mcp` from the MCP server
3. Protected resource metadata contains `authorization_servers: ["http://localhost:3001"]`
4. Client fetches `/.well-known/oauth-authorization-server` from the external AS
5. Client dynamically registers, gets redirected for authorization, exchanges code for JWT token
6. Client retries MCP connection with the JWT Bearer token
7. MCP server verifies the JWT signature via the AS's JWKS endpoint, checks issuer and audience

## Key concepts

- **RFC 9728 (Protected Resource Metadata)**: The MCP server advertises which authorization server(s) clients should use
- **RFC 8707 (Resource Indicators)**: The `resource` parameter binds tokens to a specific MCP server URL. The JWT `aud` claim is set to the MCP server's URL.
- **RFC 9068 (JWT Access Tokens)**: Tokens are self-contained JWTs, verified via JWKS without calling back to the AS
- **RFC 7591 (Dynamic Client Registration)**: Clients register themselves with the AS on first use

## Running the example

From the SDK root:

```bash
# Terminal 1: Start the external authorization server
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/externalAuthServer/authServer.ts

# Terminal 2: Start the MCP resource server
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/externalAuthServer/resourceServer.ts

# Terminal 3: Run the client
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/externalAuthServerClient.ts
```

Or from within the example directories:

```bash
# Terminal 1
cd examples/server && pnpm tsx src/externalAuthServer/authServer.ts

# Terminal 2
cd examples/server && pnpm tsx src/externalAuthServer/resourceServer.ts

# Terminal 3
cd examples/client && pnpm tsx src/externalAuthServerClient.ts
```

## Environment variables

| Variable          | Default                     | Description                                                |
| ----------------- | --------------------------- | ---------------------------------------------------------- |
| `AUTH_PORT`       | `3001`                      | Port for the external authorization server                 |
| `MCP_PORT`        | `3000`                      | Port for the MCP resource server                           |
| `AUTH_SERVER_URL` | `http://localhost:3001`     | URL of the external AS (used by resource server)           |
| `MCP_SERVER_URL`  | `http://localhost:3000/mcp` | URL of the MCP resource (used by auth server for audience) |

## Differences from simpleStreamableHttp --oauth

The existing `simpleStreamableHttp.ts --oauth` example uses `better-auth` as a co-located auth server running inside the same process. This example demonstrates a fully **decoupled** architecture:

|                    | simpleStreamableHttp --oauth    | externalAuthServer        |
| ------------------ | ------------------------------- | ------------------------- |
| Auth server        | Co-located (better-auth)        | Separate process          |
| Token format       | Opaque (better-auth session)    | JWT (RFC 9068)            |
| Token verification | Database lookup via better-auth | JWKS (no shared state)    |
| Token binding      | Session-based                   | Audience claim (RFC 8707) |
| Dependencies       | better-auth, better-sqlite3     | jose (JWT/JWKS only)      |

## Extending this example

- **Add token introspection**: Implement `/introspect` on the AS for opaque token support
- **Add token revocation**: Implement `/revoke` on the AS for logout flows
- **Add OIDC**: Extend the AS to return ID tokens alongside access tokens
- **Add scopes**: Check `scope` claims in the JWT for fine-grained access control
- **Production deployment**: Replace in-memory stores with a database, add real user authentication
