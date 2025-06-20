# Client-Level Request Identifiers

This example demonstrates the client-level request identifiers feature in the MCP TypeScript SDK. This feature allows you to:

1. Pass contextual metadata with each MCP tool call
2. Configure identifiers once at the client level for use with all tool calls
3. Add request-specific identifiers for individual tool calls
4. Forward identifiers as HTTP headers in downstream requests

## Key Files

- `server.ts`: A simple MCP server with identifier forwarding enabled
- `test-client.ts`: Comprehensive test suite demonstrating all identifier scenarios

## Getting Started

Run the comprehensive test suite with:

```bash
npx tsx src/examples/identifiers/test-client.ts
```

## Test Coverage

The test suite validates:

✅ **Core Functionality**
- Client-level identifiers only
- Request-level identifiers only  
- Identifier merging (client + request)
- Conflict resolution (request overrides client)

✅ **Edge Cases**
- Empty identifier objects
- Long values and special characters
- Backward compatibility (no identifiers)
- Various identifier naming patterns

✅ **Header Validation**
- Proper `X-MCP-` prefix formatting
- Kebab-case to Pascal-Case transformation
- End-to-end HTTP header forwarding

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

## Example Output

When running the test suite, you'll see identifiers being forwarded as HTTP headers:

```
TOOL: Will send HTTP headers:
{
  "Content-Type": "application/json",
  "X-MCP-Trace-Id": "client-trace-123",
  "X-MCP-Tenant-Id": "client-tenant-456"
}

API SERVER: Request received
MCP Headers: {
  "x-mcp-trace-id": "client-trace-123",
  "x-mcp-tenant-id": "client-tenant-456"
}
```

## Use Cases

- **Distributed tracing**: Pass trace IDs through MCP to downstream services
- **Multi-tenancy**: Forward tenant and user context for data isolation
- **Audit logging**: Maintain compliance trails across service boundaries
- **Request correlation**: Track requests across multiple MCP servers

## Security Considerations

- Identifier forwarding is disabled by default for security
- Consider enabling the `allowedKeys` filter to restrict which identifiers can be forwarded
- Use the `maxIdentifiers` and `maxValueLength` options to prevent abuse
- Identifiers are for tracking/correlation, not authentication (use proper auth mechanisms for secrets)