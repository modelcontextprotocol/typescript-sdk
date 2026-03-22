# Authentication and Authorization

The MCP TypeScript SDK provides optional, opt-in support for authentication (AuthN) and authorization (AuthZ). This enables you to protect your MCP server resources, tools, and prompts using industry-standard schemes like OAuth 2.1 Bearer tokens.

## Key Concepts

- **Authenticator**: Responsible for extracting and validating authentication information from an incoming request.
- **AuthInfo**: A structure containing information about the authenticated entity (e.g., user name, active scopes).
- **Authorizer**: Used by the MCP server to verify if the authenticated entity has the required scopes to access a specific resource, tool, or prompt.
- **Scopes**: Optional strings associated with registered items that define the required permissions.

## Implementing Authentication

To enable authentication, provide an `authenticator` in the `ServerOptions` when creating your server.

### Using Bearer Token Authentication

The SDK includes a `BearerTokenAuthenticator` for validating OAuth 2.1 Bearer tokens.

```typescript
import { McpServer, BearerTokenAuthenticator } from "@modelcontextprotocol/server";

const server = new McpServer({
  name: "my-authenticated-server",
  version: "1.0.0",
}, {
  authenticator: new BearerTokenAuthenticator({
    validate: async (token) => {
      // Validate the token (e.g., verify with an OAuth provider)
      if (token === "valid-token") {
        return {
          name: "john_doe",
          scopes: ["read:resources", "execute:tools"]
        };
      }
      return undefined; // Invalid token
    }
  })
});
```

## Implementing Authorization

Authorization is enforced using the `scopes` property when registering tools, resources, or prompts.

### Scoped Tools

```typescript
server.tool(
  "secure_tool",
  { 
    description: "A tool that requires specific scopes",
    scopes: ["execute:tools"] 
  },
  async (args) => {
    return { content: [{ type: "text", text: "Success!" }] };
  }
);
```

### Scoped Resources

```typescript
server.resource(
  "secure_resource",
  "secure://data",
  { scopes: ["read:resources"] },
  async (uri) => {
    return { contents: [{ uri: uri.href, text: "Top secret data" }] };
  }
);
```

## Middleware Support

For framework-specific integrations, use the provided middleware to pre-authenticate requests.

### Express Middleware

```typescript
import express from "express";
import { auth } from "@modelcontextprotocol/express";

const app = express();
app.use(auth({ authenticator }));

app.post("/mcp", (req, res) => {
  // req.auth is now populated
  transport.handleRequest(req, res);
});
```

### Hono Middleware

```typescript
import { Hono } from "hono";
import { auth } from "@modelcontextprotocol/hono";

const app = new Hono();
app.use("/mcp/*", auth({ authenticator }));

app.all("/mcp", async (c) => {
  const authInfo = c.get("mcpAuthInfo");
  return transport.handleRequest(c.req.raw, { authInfo });
});
```

## Error Handling

- **401 Unauthorized**: Returned when authentication is required but missing or invalid. Includes `WWW-Authenticate: Bearer` header.
- **403 Forbidden**: Returned when the authenticated entity lacks the required scopes.
