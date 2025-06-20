# Client-Level Request Identifiers

This example demonstrates the client-level request identifiers feature in the MCP TypeScript SDK. This feature allows you to:

1. Pass contextual metadata with each MCP tool call
2. Configure identifiers once at the client level for use with all tool calls
3. Add request-specific identifiers for individual tool calls
4. Forward identifiers as HTTP headers in downstream requests

## Key Files

- `server.ts`: A simple MCP server with identifier forwarding enabled
- `test-client.ts`: Client that demonstrates both client-level and request-level identifiers

## Getting Started

Run the example with:

```bash
npx tsx src/examples/identifiers/test-client.ts
```

## How It Works

### Client-Side Configuration

Client-level identifiers are configured when initializing the client:

```typescript
// Create a client with client-level identifiers
const client = new Client(
  {
    name: "my-client",
    version: "1.0.0"
  },
  {
    identifiers: {
      "trace-id": "client-trace-123",
      "tenant-id": "default-tenant"
    }
  }
);
```

**Important**: The `identifiers` must be in the second parameter (options) when creating a Client.

### Request-Level Identifiers

You can also specify request-specific identifiers for individual tool calls:

```typescript
const result = await client.callTool({
  name: "my_tool",
  arguments: { /* tool args */ },
  identifiers: {
    "request-id": "req-789",
    "user-id": "user-abc"
  }
});
```

When a request has both client-level and request-level identifiers:
- All identifiers from both sources are included
- Request-level identifiers take precedence when keys conflict

### Server-Side Configuration

Identifier forwarding is disabled by default. To enable it, configure the MCP server:

```typescript
const mcpServer = new McpServer(
  { name: "my-server", version: "1.0.0" },
  {
    identifierForwarding: {
      enabled: true,             // Must be set to true to enable
      headerPrefix: "X-MCP-",    // Prefix for HTTP headers
      allowedKeys: ["trace-id", "tenant-id"], // Restrict which identifiers can be forwarded
      maxIdentifiers: 20,        // Limit total number of identifiers
      maxValueLength: 256        // Limit identifier value length
    }
  }
);
```

### Tool Implementation

Tool implementations receive identifiers through the `extra` object:

```typescript
mcpServer.registerTool("my_tool", {
  // tool configuration
}, async (args, extra) => {
  // Access the identifiers
  const traceId = extra.identifiers?.["trace-id"];
  
  // Forward identifiers as HTTP headers
  const requestOptions = extra.applyIdentifiersToRequestOptions({
    headers: { /* your headers */ }
  });
  
  // Make HTTP request with forwarded identifiers
  const response = await fetch("https://api.example.com", {
    ...requestOptions,
    // other fetch options
  });
  
  // Rest of implementation
});
```

## Use Cases

- Distributed tracing
- Multi-tenancy
- User context propagation
- Request correlation

## Security Considerations

- Identifier forwarding is disabled by default for security
- Consider enabling the `allowedKeys` filter to restrict which identifiers can be forwarded
- Use the `maxIdentifiers` and `maxValueLength` options to prevent abuse
