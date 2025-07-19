# TypeScript SDK API Reference

## Overview
This document provides a comprehensive API reference for the Model Context Protocol (MCP) TypeScript SDK.

## Installation
```bash
npm install @modelcontextprotocol/typescript-sdk
```

## Core Types

### Import Path: `@modelcontextprotocol/typescript-sdk/types`

#### Constants
- `LATEST_PROTOCOL_VERSION: "2025-06-18"`
- `DEFAULT_NEGOTIATED_PROTOCOL_VERSION: "2025-03-26"`
- `SUPPORTED_PROTOCOL_VERSIONS: string[]`
- `JSONRPC_VERSION: "2.0"`

#### Error Codes
```typescript
enum ErrorCode {
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}
```

#### Core Schemas
- `ProgressTokenSchema`
- `CursorSchema`
- `RequestSchema`
- `NotificationSchema`
- `ResultSchema`
- `RequestIdSchema`
- `JSONRPCRequestSchema`
- `JSONRPCNotificationSchema`
- `JSONRPCResponseSchema`
- `JSONRPCErrorSchema`
- `JSONRPCMessageSchema`
- `EmptyResultSchema`
- `CancelledNotificationSchema`
- `BaseMetadataSchema`
- `ImplementationSchema`
- `ClientCapabilitiesSchema`
- `ServerCapabilitiesSchema`

## Client API

### Import Path: `@modelcontextprotocol/typescript-sdk/client`

#### Client Class
```typescript
class Client<RequestT, NotificationT, ResultT> extends Protocol {
  constructor(clientInfo: Implementation, options?: ClientOptions)
  
  // Methods
  connect(transport: Transport, options?: RequestOptions): Promise<void>
  getServerCapabilities(): ServerCapabilities | undefined
  getServerVersion(): Implementation | undefined
  getInstructions(): string | undefined
  registerCapabilities(capabilities: ClientCapabilities): void
  
  // Tool operations
  callTool(name: string, arguments?: object, options?: RequestOptions): Promise<CallToolResult>
  listTools(options?: RequestOptions): Promise<ListToolsResult>
  
  // Resource operations
  listResources(options?: RequestOptions): Promise<ListResourcesResult>
  readResource(uri: string, options?: RequestOptions): Promise<ReadResourceResult>
  subscribeResource(uri: string, options?: RequestOptions): Promise<EmptyResult>
  unsubscribeResource(uri: string, options?: RequestOptions): Promise<EmptyResult>
  
  // Prompt operations
  getPrompt(name: string, arguments?: object, options?: RequestOptions): Promise<GetPromptResult>
  listPrompts(options?: RequestOptions): Promise<ListPromptsResult>
  
  // Logging
  setLogLevel(level: LoggingLevel, options?: RequestOptions): Promise<EmptyResult>
}

interface ClientOptions extends ProtocolOptions {
  capabilities?: ClientCapabilities
}
```

## Server API

### Import Path: `@modelcontextprotocol/typescript-sdk/server`

#### Server Class
```typescript
class Server<RequestT, NotificationT, ResultT> extends Protocol {
  constructor(serverInfo: Implementation, options?: ServerOptions)
  
  // Methods
  registerCapabilities(capabilities: ServerCapabilities): void
  oninitialized?: () => void
  
  // Request handlers
  setRequestHandler<RequestParam, ResponseResult>(
    schema: ZodSchema<RequestParam>,
    handler: (request: RequestParam) => Promise<ResponseResult>
  ): void
  
  // Notification handlers
  setNotificationHandler<NotificationParam>(
    schema: ZodSchema<NotificationParam>,
    handler: (notification: NotificationParam) => Promise<void> | void
  ): void
  
  // Convenience methods
  prompt(name: string, description?: string, fn?: PromptHandler): void
  resource(uri: string, name: string, fn?: ResourceHandler): void
  tool(name: string, description?: string, fn?: ToolHandler): void
  
  // Notifications
  notifyResourceUpdated(uri: string): void
  notifyResourceListChanged(): void
  notifyToolListChanged(): void
  notifyPromptListChanged(): void
  notifyLog(level: LoggingLevel, message: string): void
}

interface ServerOptions extends ProtocolOptions {
  capabilities?: ServerCapabilities
  instructions?: string
}
```

## Transport Layer

### Import Path: `@modelcontextprotocol/typescript-sdk/shared/transport`

#### Transport Interface
```typescript
interface Transport {
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  
  start(): Promise<void>
  send(message: JSONRPCMessage): Promise<void>
  close(): Promise<void>
  
  sessionId?: string
  setProtocolVersion?(version: string): void
}
```

#### Transport Implementations

##### Stdio Transport
```typescript
import { StdioClientTransport } from "@modelcontextprotocol/typescript-sdk/client/stdio"
import { StdioServerTransport } from "@modelcontextprotocol/typescript-sdk/server/stdio"

// Client
const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"]
})

// Server
const transport = new StdioServerTransport()
```

##### SSE Transport
```typescript
import { SSEClientTransport } from "@modelcontextprotocol/typescript-sdk/client/sse"
import { SSEServerTransport } from "@modelcontextprotocol/typescript-sdk/server/sse"

// Client
const transport = new SSEClientTransport(new URL("http://localhost:3000/sse"))

// Server
const transport = new SSEServerTransport(req, res)
```

##### Streamable HTTP Transport
```typescript
import { StreamableHttpClientTransport } from "@modelcontextprotocol/typescript-sdk/client/streamableHttp"
import { StreamableHttpServerTransport } from "@modelcontextprotocol/typescript-sdk/server/streamableHttp"

// Client
const transport = new StreamableHttpClientTransport(new URL("http://localhost:3000/mcp"))

// Server
const transport = new StreamableHttpServerTransport()
```

## Authentication

### Import Path: `@modelcontextprotocol/typescript-sdk/client/auth`

#### Auth Types
```typescript
interface AuthInfo {
  userId: string
  token: string
  expiresAt?: Date
}

// OAuth2
import { OAuth2Client } from "@modelcontextprotocol/typescript-sdk/client/auth"
const oauth = new OAuth2Client({
  clientId: "your-client-id",
  redirectUri: "http://localhost:3000/callback",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token"
})
```

### Import Path: `@modelcontextprotocol/typescript-sdk/server/auth`

#### Server Auth
```typescript
import { createAuthMiddleware } from "@modelcontextprotocol/typescript-sdk/server/auth"

const auth = createAuthMiddleware({
  providers: [new OAuth2Provider({
    clientId: "your-client-id",
    clientSecret: "your-client-secret",
    redirectUri: "http://localhost:3000/callback"
  })]
})
```

## Protocol Base Class

### Import Path: `@modelcontextprotocol/typescript-sdk/shared/protocol`

#### Protocol Class
```typescript
class Protocol<RequestT, NotificationT, ResultT> {
  constructor(options?: ProtocolOptions)
  
  // Connection management
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
  
  // Request/Response
  request<T>(method: string, params?: any, options?: RequestOptions): Promise<T>
  notification(method: string, params?: any): Promise<void>
  
  // Error handling
  protected handleError(error: Error): void
}

interface ProtocolOptions {
  requestTimeout?: number
}

interface RequestOptions {
  timeout?: number
  signal?: AbortSignal
}
```

## Error Handling

### Import Path: `@modelcontextprotocol/typescript-sdk/types`

#### McpError Class
```typescript
class McpError extends Error {
  constructor(public code: ErrorCode, message: string)
}

// Usage
throw new McpError(ErrorCode.MethodNotFound, "Method not found")
```

## Usage Examples

### Client Example
```typescript
import { Client } from "@modelcontextprotocol/typescript-sdk/client"
import { StdioClientTransport } from "@modelcontextprotocol/typescript-sdk/client/stdio"

const client = new Client({
  name: "MyClient",
  version: "1.0.0"
})

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"]
})

await client.connect(transport)

// List available tools
const tools = await client.listTools()

// Call a tool
const result = await client.callTool("calculator", { expression: "2+2" })
```

### Server Example
```typescript
import { Server } from "@modelcontextprotocol/typescript-sdk/server"
import { StdioServerTransport } from "@modelcontextprotocol/typescript-sdk/server/stdio"

const server = new Server({
  name: "MyServer",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
})

// Register a tool
server.tool("calculator", "A simple calculator", async ({ expression }) => {
  return {
    content: [{
      type: "text",
      text: eval(expression).toString()
    }]
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

## Advanced Features

### Custom Request/Response Types
```typescript
// Extend base types
interface CustomRequest extends Request {
  method: "custom/method"
  params: { customParam: string }
}

interface CustomResult extends Result {
  customResult: string
}

// Use with Client/Server
const client = new Client<CustomRequest, Notification, CustomResult>(...)
```

### Progress Notifications
```typescript
// Server-side progress
await server.progress(token, {
  progress: 50,
  message: "Processing..."
})

// Client-side progress handling
client.onprogress = (token, progress) => {
  console.log(`Progress: ${progress.progress}%`)
}
```

### Resource Subscriptions
```typescript
// Server notifies resource changes
server.notifyResourceUpdated("file:///path/to/resource")

// Client subscribes to resource
await client.subscribeResource("file:///path/to/resource")
```

## Quick Reference

### Essential Imports
```typescript
// Client
import { Client } from '@modelcontextprotocol/typescript-sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/typescript-sdk/client/stdio'

// Server  
import { Server } from '@modelcontextprotocol/typescript-sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/typescript-sdk/server/stdio'

// Types
import { ErrorCode, McpError } from '@modelcontextprotocol/typescript-sdk/types'

// Transport
import { Transport } from '@modelcontextprotocol/typescript-sdk/shared/transport'
```

### Common Patterns
```typescript
// Client connection
const client = new Client({ name: 'client', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: 'server' }))

// Server setup
const server = new Server({ name: 'server', version: '1.0.0' })
server.tool('echo', 'Echo input', async ({ text }) => ({ content: [{ type: 'text', text }] }))
await server.connect(new StdioServerTransport())
```
