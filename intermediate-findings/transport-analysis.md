# MCP TypeScript SDK Transport Architecture Analysis

## Executive Summary

This document provides a comprehensive analysis of the transport layer implementation in the MCP TypeScript SDK, focusing on how messages flow through the system, validation mechanisms, error handling, and potential areas for improvement.

## 1. Architecture Overview

### 1.1 Core Transport Architecture

The MCP SDK uses a **layered architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────┐
│         Client / Server (High-level API)                │
│  - Client class (src/client/index.ts)                   │
│  - Server class (src/server/index.ts)                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│             Protocol Layer                              │
│  - Protocol class (src/shared/protocol.ts)              │
│  - Request/Response handling                            │
│  - Progress tracking                                    │
│  - Capability enforcement                               │
│  - Timeout management                                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│             Transport Interface                         │
│  (src/shared/transport.ts)                              │
│  - start(), send(), close()                             │
│  - onmessage, onerror, onclose callbacks                │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│         Transport Implementations                       │
│  - StdioClientTransport                                 │
│  - SSEClientTransport / SSEServerTransport              │
│  - StreamableHTTPClientTransport / Server               │
│  - InMemoryTransport (testing)                          │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Key Design Principles

1. **Transport Agnostic**: The Protocol layer is completely independent of the transport mechanism
2. **Callback-Based**: Transport implementations use callbacks (`onmessage`, `onerror`, `onclose`) to push data up
3. **Async Operations**: All transport operations return Promises
4. **Schema Validation**: Zod schemas validate messages at the protocol boundary

## 2. Key Files and Their Purposes

### 2.1 Core Transport Files

#### `/src/shared/transport.ts` (86 lines)
**Purpose**: Defines the Transport interface contract

**Key Types**:
- `Transport` interface: The contract all transport implementations must fulfill
- `TransportSendOptions`: Options for sending messages (relatedRequestId, resumption tokens)
- `FetchLike`: Type for custom fetch implementations

**Core Interface**:
```typescript
interface Transport {
  start(): Promise<void>;                    // Initialize connection
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;

  // Callbacks
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  // Optional features
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}
```

#### `/src/shared/protocol.ts` (785 lines)
**Purpose**: Implements the MCP protocol layer on top of any transport

**Key Responsibilities**:
1. **Request/Response Correlation**: Maps request IDs to response handlers
2. **Progress Tracking**: Handles progress notifications via progress tokens
3. **Timeout Management**: Implements per-request timeouts with optional progress-based reset
4. **Capability Enforcement**: Validates that requests match advertised capabilities
5. **Request Cancellation**: Supports AbortSignal-based cancellation
6. **Notification Debouncing**: Can coalesce multiple notifications in the same tick
7. **Request Handler Management**: Routes incoming requests to registered handlers

**Key Data Structures**:
```typescript
private _requestMessageId = 0;  // Monotonic counter for request IDs
private _requestHandlers: Map<string, Handler>
private _notificationHandlers: Map<string, Handler>
private _responseHandlers: Map<number, ResponseHandler>
private _progressHandlers: Map<number, ProgressCallback>
private _timeoutInfo: Map<number, TimeoutInfo>
private _pendingDebouncedNotifications: Set<string>
```

**Critical Design Pattern - Transport Capture**:
The protocol uses a **transport capture pattern** in `_onrequest()` to ensure responses go to the correct client when multiple connections exist:

```typescript
// Capture the current transport at request time
const capturedTransport = this._transport;

// Use capturedTransport for sending responses, not this._transport
```

This prevents a race condition where reconnections could send responses to the wrong client.

### 2.2 Transport Implementations

#### Stdio Transport (`/src/shared/stdio.ts`, `/src/client/stdio.ts`)
- **Communication**: Line-delimited JSON over stdin/stdout
- **Serialization**: `serializeMessage()` adds newline, `deserializeMessage()` uses Zod validation
- **Buffering**: `ReadBuffer` class handles partial message buffering
- **Use Case**: Local process communication, MCP servers as child processes

#### SSE Transport (Client: `/src/client/sse.ts`, Server: `/src/server/sse.ts`)
- **Client Receives**: Via Server-Sent Events (GET request with EventSource)
- **Client Sends**: Via POST requests to endpoint provided by server
- **Server Receives**: POST requests with JSON body
- **Server Sends**: SSE stream with `event: message` format
- **Authentication**: Integrated OAuth support with UnauthorizedError handling
- **Security**: DNS rebinding protection (optional, configurable)

#### Streamable HTTP Transport
**Client** (`/src/client/streamableHttp.ts` - 570 lines):
- Most complex transport implementation
- Bidirectional HTTP with SSE for server-to-client messages
- **Reconnection Logic**: Exponential backoff with configurable parameters
- **Resumability**: Last-Event-ID header for resuming interrupted streams
- **Session Management**: Tracks session ID across reconnections

**Server** (`/src/server/streamableHttp.ts`):
- Stateful (session-based) and stateless modes
- Event store interface for resumability support
- Stream management for multiple concurrent requests

#### InMemory Transport (`/src/inMemory.ts` - 64 lines)
- Testing-only transport
- Direct in-memory message passing
- Useful for unit tests and integration tests

### 2.3 Protocol Types

#### `/src/types.ts` (1500+ lines)
**Purpose**: Central type definitions using Zod schemas

**Key Message Types**:
```typescript
// Base types
JSONRPCRequest    // { jsonrpc: "2.0", id, method, params }
JSONRPCNotification  // { jsonrpc: "2.0", method, params }
JSONRPCResponse   // { jsonrpc: "2.0", id, result }
JSONRPCError      // { jsonrpc: "2.0", id, error: { code, message, data? }}
```

**Error Codes**:
```typescript
enum ErrorCode {
  // SDK-specific
  ConnectionClosed = -32000,
  RequestTimeout = -32001,

  // JSON-RPC standard
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}
```

**MessageExtraInfo** (line 1551):
```typescript
interface MessageExtraInfo {
  requestInfo?: RequestInfo;  // HTTP headers, etc.
  authInfo?: AuthInfo;        // OAuth token info
}
```

## 3. Message Flow

### 3.1 Outgoing Request Flow (Client -> Server)

```
┌──────────────────┐
│  Client.request()│
└────────┬─────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Protocol.request()                     │
│  - Generate message ID                 │
│  - Add progress token if requested     │
│  - Register response handler           │
│  - Set up timeout                      │
│  - Set up cancellation handler         │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Transport.send(JSONRPCRequest)         │
│  - Serialize message                   │
│  - Send over wire (HTTP/SSE/stdio)     │
└────────────────────────────────────────┘
```

### 3.2 Incoming Request Flow (Server <- Client)

```
┌────────────────────────────────────────┐
│ Transport receives data                │
│  - Parse JSON                          │
│  - Validate with Zod schema            │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Transport.onmessage(message, extra)    │
│  - extra contains authInfo, headers    │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Protocol._onrequest()                  │
│  - Capture current transport           │
│  - Look up handler                     │
│  - Create AbortController              │
│  - Build RequestHandlerExtra context   │
│  - Execute handler                     │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Request Handler                        │
│  - Business logic                      │
│  - Can send notifications              │
│  - Can make requests                   │
│  - Returns Result                      │
└────────┬───────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────┐
│ Send Response                          │
│  - Use capturedTransport.send()        │
│  - Send JSONRPCResponse or Error       │
└────────────────────────────────────────┘
```

### 3.3 Progress Notification Flow

```
Client Request (with onprogress)
         │
         ▼
Request includes _meta: { progressToken: messageId }
         │
         ▼
Server Handler receives request
         │
         ▼
Server sends: notifications/progress
  { params: { progressToken, progress, total, message? }}
         │
         ▼
Client Protocol._onprogress()
  - Look up handler by progressToken
  - Optionally reset timeout
  - Call onprogress callback
```

## 4. Validation Mechanisms

### 4.1 Schema Validation (Zod)

**Where**: At the transport boundary when messages are received

**Implementation**:
```typescript
// In shared/stdio.ts
export function deserializeMessage(line: string): JSONRPCMessage {
  return JSONRPCMessageSchema.parse(JSON.parse(line));
}

// In SSE transports
const message = JSONRPCMessageSchema.parse(JSON.parse(messageEvent.data));

// In protocol request handlers
this._requestHandlers.set(method, (request, extra) => {
  return Promise.resolve(handler(requestSchema.parse(request), extra));
});
```

**Validation Levels**:
1. **Message Structure**: JSONRPCMessageSchema validates basic JSON-RPC structure
2. **Request Params**: Individual request schemas validate params structure
3. **Result Schema**: Response results are validated against expected schemas
4. **Type Guards**: Helper functions like `isJSONRPCRequest()`, `isJSONRPCResponse()`

### 4.2 Capability Validation

**Where**: In Client and Server classes before sending requests

**Methods**:
- `assertCapabilityForMethod()`: Checks remote side supports the request method
- `assertNotificationCapability()`: Checks local side advertised notification support
- `assertRequestHandlerCapability()`: Checks local side advertised handler support

**Example from Client**:
```typescript
protected assertCapabilityForMethod(method: RequestT["method"]): void {
  switch (method as ClientRequest["method"]) {
    case "tools/call":
    case "tools/list":
      if (!this._serverCapabilities?.tools) {
        throw new Error(
          `Server does not support tools (required for ${method})`
        );
      }
      break;
    // ... more cases
  }
}
```

**Enforcement**: Optional via `enforceStrictCapabilities` option (defaults to false for backwards compatibility)

### 4.3 Client-Side Tool Output Validation

**Special Case**: Client validates tool call results against declared output schemas

**Implementation** (`/src/client/index.ts`, lines 429-479):
```typescript
async callTool(params, resultSchema, options) {
  const result = await this.request(...);

  const validator = this.getToolOutputValidator(params.name);
  if (validator) {
    // Tool with outputSchema MUST return structuredContent
    if (!result.structuredContent && !result.isError) {
      throw new McpError(...);
    }

    // Validate structured content against schema
    if (result.structuredContent) {
      const isValid = validator(result.structuredContent);
      if (!isValid) {
        throw new McpError(...);
      }
    }
  }

  return result;
}
```

**Why This Exists**: Ensures servers respect their own tool output schemas

### 4.4 Transport-Specific Validation

#### DNS Rebinding Protection
Both SSE and StreamableHTTP server transports support optional DNS rebinding protection:

```typescript
private validateRequestHeaders(req: IncomingMessage): string | undefined {
  if (!this._enableDnsRebindingProtection) return undefined;

  // Validate Host header
  if (this._allowedHosts && !this._allowedHosts.includes(req.headers.host)) {
    return `Invalid Host header`;
  }

  // Validate Origin header
  if (this._allowedOrigins && !this._allowedOrigins.includes(req.headers.origin)) {
    return `Invalid Origin header`;
  }

  return undefined;
}
```

#### Session Validation (StreamableHTTP stateful mode)
- Validates session ID in headers matches expected session
- Returns 404 if session not found
- Returns 400 if non-initialization request lacks session ID

## 5. Error Handling

### 5.1 Error Types and Hierarchy

```
Error (JavaScript base)
  │
  ├─ McpError (general MCP errors with error codes)
  │   - ConnectionClosed
  │   - RequestTimeout
  │   - ParseError
  │   - InvalidRequest
  │   - MethodNotFound
  │   - InvalidParams
  │   - InternalError
  │
  ├─ TransportError (transport-specific errors)
  │   ├─ SseError (SSE transport errors)
  │   ├─ StreamableHTTPError (Streamable HTTP errors)
  │   └─ UnauthorizedError (authentication failures)
  │
  └─ OAuthError (authentication/authorization errors)
      └─ [Many specific OAuth error types]
```

### 5.2 Error Handling Patterns

#### Protocol Layer Error Handling

**Request Handler Errors**:
```typescript
Promise.resolve()
  .then(() => handler(request, fullExtra))
  .then(
    (result) => capturedTransport?.send({ result, ... }),
    (error) => capturedTransport?.send({
      error: {
        code: Number.isSafeInteger(error["code"]) ? error["code"] : ErrorCode.InternalError,
        message: error.message ?? "Internal error"
      }
    })
  )
  .catch((error) => this._onerror(new Error(`Failed to send response: ${error}`)))
```

**Key Behaviors**:
1. Errors are caught and converted to JSON-RPC error responses
2. If error has numeric `code`, it's preserved; otherwise defaults to InternalError
3. If sending the error response fails, it's reported via `onerror` callback
4. Aborted requests don't send responses

#### Transport Layer Error Handling

**Stdio Transport**:
- Zod validation errors reported via `onerror`
- Process spawn errors reject start() promise
- Stream errors reported via `onerror`

**SSE/StreamableHTTP Transports**:
- Network errors caught and reported via `onerror`
- 401 responses trigger authentication flow (if authProvider present)
- Connection close triggers cleanup and `onclose` callback
- Reconnection with exponential backoff (StreamableHTTP only)

### 5.3 Error Propagation

```
Transport Layer
  └─> onerror(error) callback
       │
       ▼
Protocol Layer
  └─> this.onerror(error) callback
       │
       ▼
Client/Server Layer
  └─> User-defined onerror handler
```

**Request/Response Errors**:
- Returned as rejected Promise from `request()` method
- Either McpError (from remote) or Error (local/transport)

**Notification Handler Errors**:
- Caught and reported via `onerror`
- Do not affect other operations

## 6. Gaps and Potential Issues

### 6.1 Validation Gaps

#### 6.1.1 Incomplete Message Validation
**Issue**: While JSON-RPC structure is validated, there's limited validation of:
- Message content before sending (only validated on receive)
- Semantic correctness of method names
- Parameter structure matching method requirements

**Evidence**:
- No validation in `Protocol.request()` that `request.method` is valid before sending
- Transport implementations assume messages are well-formed

**Impact**: Invalid messages can be sent and only caught by the receiver

#### 6.1.2 No Validation of TransportSendOptions
**Issue**: `TransportSendOptions` (relatedRequestId, resumptionToken) are not validated

**Potential Problems**:
- Invalid resumption tokens could cause server errors
- Wrong relatedRequestId could break request association

#### 6.1.3 Missing Protocol Version Validation During Send
**Issue**: After negotiation, protocol version is stored but not validated on every message

**Current State**:
- `setProtocolVersion()` called after initialization
- No validation that subsequent messages conform to negotiated version

### 6.2 Error Handling Gaps

#### 6.2.1 Limited Error Context
**Issue**: Errors often lose context as they propagate

**Example**: When `JSONRPCMessageSchema.parse()` fails:
```typescript
try {
  message = JSONRPCMessageSchema.parse(JSON.parse(messageEvent.data));
} catch (error) {
  this.onerror?.(error as Error);  // Original message content is lost
  return;
}
```

**Better Approach**: Include the raw message in error context

#### 6.2.2 Silent Failures in Some Paths
**Issue**: Some error paths don't propagate errors effectively

**Example in Protocol**:
```typescript
this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
// Message is dropped silently if no onerror handler
```

**Better Approach**: Throw error or have required error handling

#### 6.2.3 No Error Recovery Mechanisms
**Issue**: Most errors are fatal to the connection

**Missing**:
- Ability to recover from transient errors
- Retry logic for failed sends (except StreamableHTTP reconnection)
- Graceful degradation when features are unavailable

### 6.3 Transport-Specific Issues

#### 6.3.1 Race Conditions in Protocol Connection
**Evidence**: The `protocol-transport-handling.test.ts` shows a bug where multiple rapid connections can send responses to the wrong client

**Fix Applied**: Transport capture pattern in `_onrequest()`

**Remaining Risk**: Similar issues could occur with:
- Progress notifications sent to wrong client
- Notification handlers accessing wrong transport

#### 6.3.2 No Backpressure Handling
**Issue**: None of the transports implement backpressure or flow control

**Potential Problems**:
- Stdio: If stdin write buffer fills, could block
- HTTP: No limit on concurrent requests
- No queuing or rate limiting

#### 6.3.3 Incomplete Resumability Implementation
**Status**: Resumability API exists but:
- Only StreamableHTTP client supports it
- Server-side EventStore is an interface with no default implementation
- No automatic resumability without custom EventStore

### 6.4 Protocol Layer Issues

#### 6.4.1 Timeout Reset Logic Complexity
**Issue**: The timeout reset logic (for progress notifications) is complex and error-prone

**Code** (lines 268-285):
```typescript
private _resetTimeout(messageId: number): boolean {
  const info = this._timeoutInfo.get(messageId);
  if (!info) return false;

  const totalElapsed = Date.now() - info.startTime;
  if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
    this._timeoutInfo.delete(messageId);
    throw new McpError(...);  // Throws from unexpected context
  }

  clearTimeout(info.timeoutId);
  info.timeoutId = setTimeout(info.onTimeout, info.timeout);
  return true;
}
```

**Problem**: Throws exception that gets caught in progress handler, but the flow is not obvious

#### 6.4.2 Request Handler Memory Leak Risk
**Issue**: AbortControllers are stored in `_requestHandlerAbortControllers` map

**Risk**: If request handling never completes (handler hangs), entries never cleaned up

**Mitigation**: Cleanup happens in `finally` block, but what if handler never returns?

#### 6.4.3 No Rate Limiting or Request Queue Management
**Issue**: Unlimited concurrent requests are allowed

**Problems**:
- Memory usage can grow unbounded
- No prioritization of requests
- No limit on message IDs (though it's just a counter)

### 6.5 Testing and Observability Gaps

#### 6.5.1 Limited Error Testing
**Observation**: Test files focus on happy paths

**Missing Tests**:
- Malformed JSON handling
- Invalid protocol version negotiation
- Capability violations
- Concurrent request/connection scenarios

#### 6.5.2 No Built-in Logging or Tracing
**Issue**: No standardized way to trace messages through the system

**Current State**: Each component can report via `onerror`, but:
- No structured logging
- No message IDs in logs
- No performance metrics

#### 6.5.3 Proposed Transport Validator Not Integrated
**Evidence**: `src/shared/transport-validator.ts` exists with a `ProtocolValidator` class

**Status**:
- Not used anywhere in codebase
- Implements logging but not enforcement
- Could be the foundation for protocol validation

**Potential**:
```typescript
class ProtocolValidator implements Transport {
  private log: ProtocolLog = { events: [] }

  // Wraps a transport and logs all events
  // Can run checkers on the log
}
```

This could validate:
- Message ordering (initialize must be first)
- Request/response pairing
- Capability usage
- Protocol version conformance

## 7. Existing Validation Infrastructure

### 7.1 Zod Schema System

**Strengths**:
- Comprehensive type definitions
- Runtime validation
- Type inference for TypeScript
- Good error messages

**Coverage**:
- All JSON-RPC message types
- All MCP-specific request/response types
- Capability structures
- Metadata structures

### 7.2 Type Guards

**Available Functions**:
```typescript
isJSONRPCRequest(value)
isJSONRPCResponse(value)
isJSONRPCError(value)
isJSONRPCNotification(value)
isInitializeRequest(value)
isInitializedNotification(value)
```

**Usage Pattern**:
```typescript
if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
  this._onresponse(message);
} else if (isJSONRPCRequest(message)) {
  this._onrequest(message, extra);
} else if (isJSONRPCNotification(message)) {
  this._onnotification(message);
}
```

### 7.3 Test Infrastructure

**Available**:
- InMemoryTransport for testing
- MockTransport in test files
- Protocol test suite with various scenarios
- Transport-specific test suites

**Good Coverage Of**:
- Basic message flow
- Error scenarios
- Timeout behavior
- Progress notifications
- Debounced notifications

## 8. Recommendations for Protocol Validation Improvements

### 8.1 High Priority

#### 8.1.1 Integrate Transport Validator
**Action**: Complete and integrate the ProtocolValidator class

**Benefits**:
- Centralized validation logic
- Protocol conformance checking
- Better debugging and testing

**Implementation**:
```typescript
// Wrap any transport with validation
const validatedTransport = new ProtocolValidator(
  rawTransport,
  [
    checkInitializeFirst,
    checkRequestResponsePairing,
    checkCapabilityUsage,
  ]
);
```

#### 8.1.2 Enhanced Error Context
**Action**: Add message context to validation errors

**Example**:
```typescript
catch (error) {
  this.onerror?.(new Error(
    `Failed to parse message: ${error}\nRaw message: ${rawMessage}`
  ));
}
```

#### 8.1.3 Pre-Send Validation
**Action**: Validate messages before sending

**Implementation**:
```typescript
async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
  // Validate message structure
  const parseResult = JSONRPCMessageSchema.safeParse(message);
  if (!parseResult.success) {
    throw new Error(`Invalid message: ${parseResult.error}`);
  }

  // Validate options
  if (options?.resumptionToken && typeof options.resumptionToken !== 'string') {
    throw new Error('Invalid resumption token');
  }

  // Send validated message
  return this._actualSend(message, options);
}
```

### 8.2 Medium Priority

#### 8.2.1 Structured Logging
**Action**: Add optional structured logging throughout

**Example**:
```typescript
interface TransportLogger {
  logMessageSent(message: JSONRPCMessage, options?: TransportSendOptions): void;
  logMessageReceived(message: JSONRPCMessage, extra?: MessageExtraInfo): void;
  logError(error: Error, context?: Record<string, unknown>): void;
}
```

#### 8.2.2 Backpressure Support
**Action**: Add flow control to prevent overwhelming the transport

**API**:
```typescript
interface Transport {
  // ...existing methods
  canSend?(): boolean;  // Check if ready to accept messages
  onready?: () => void;  // Called when ready to send after backpressure
}
```

#### 8.2.3 Request Queue Management
**Action**: Add limits and prioritization

**Options**:
```typescript
interface ProtocolOptions {
  // ...existing options
  maxConcurrentRequests?: number;
  requestQueueSize?: number;
}
```

### 8.3 Low Priority (Future Enhancements)

#### 8.3.1 Automatic Retry Logic
**Action**: Add configurable retry for failed requests

**Options**:
```typescript
interface RequestOptions {
  // ...existing options
  retry?: {
    maxAttempts: number;
    backoff: 'exponential' | 'linear';
    retryableErrors?: number[];  // Error codes that should be retried
  };
}
```

#### 8.3.2 Message Compression
**Action**: Support compressed message payloads for large transfers

#### 8.3.3 Message Batching
**Action**: Allow batching multiple requests in one transport send

## 9. How Protocol Validation Could Be Improved

### 9.1 State Machine Based Validation

**Concept**: Track protocol state and validate allowed transitions

```typescript
enum ProtocolState {
  Disconnected,
  Connecting,
  Initializing,
  Initialized,
  Closing,
  Closed,
}

class StatefulProtocolValidator {
  private state: ProtocolState = ProtocolState.Disconnected;

  validateMessage(message: JSONRPCMessage): ValidationResult {
    if (this.state === ProtocolState.Connecting &&
        !isInitializeRequest(message)) {
      return { valid: false, error: 'Must send initialize first' };
    }

    // ...more state-based validation

    return { valid: true };
  }
}
```

### 9.2 Message Sequence Validation

**Track**:
- Initialize must be first request
- Initialized notification must follow initialize response
- No requests before initialized (except cancel/ping)
- Request IDs must be unique per direction
- Response IDs must match request IDs

### 9.3 Capability-Based Validation

**Enhance**:
```typescript
class CapabilityValidator {
  constructor(
    private localCapabilities: Capabilities,
    private remoteCapabilities: Capabilities
  ) {}

  canSendRequest(method: string): ValidationResult {
    // Check if remote side advertised support
  }

  canHandleRequest(method: string): ValidationResult {
    // Check if local side advertised support
  }

  canSendNotification(method: string): ValidationResult {
    // Check if local side advertised capability
  }
}
```

### 9.4 Schema-Based Request Validation

**Validate request params match method schema**:
```typescript
class RequestValidator {
  private schemas = new Map<string, ZodSchema>();

  validateRequest(request: JSONRPCRequest): ValidationResult {
    const schema = this.schemas.get(request.method);
    if (!schema) {
      return { valid: false, error: 'Unknown method' };
    }

    const result = schema.safeParse(request.params);
    if (!result.success) {
      return { valid: false, error: result.error };
    }

    return { valid: true };
  }
}
```

## 10. Summary

### Strengths
1. ✅ Clean separation between protocol and transport layers
2. ✅ Comprehensive Zod-based type system
3. ✅ Good test coverage for basic scenarios
4. ✅ Flexible transport interface supports multiple implementations
5. ✅ Robust timeout and cancellation support
6. ✅ Authentication integration for HTTP-based transports

### Weaknesses
1. ❌ Limited pre-send validation
2. ❌ Error context often lost during propagation
3. ❌ No backpressure or flow control
4. ❌ ProtocolValidator class exists but not integrated
5. ❌ Limited observability (logging, tracing)
6. ❌ Some race conditions with multiple connections

### Opportunities
1. 💡 Integrate and expand ProtocolValidator
2. 💡 Add state machine based protocol validation
3. 💡 Improve error context and recovery
4. 💡 Add structured logging/tracing
5. 💡 Implement backpressure handling
6. 💡 Add request queue management and prioritization

### Protocol Validation Specific
The codebase has excellent **foundations** for protocol validation:
- Comprehensive schemas
- Type guards
- Capability system
- Unused ProtocolValidator class

What's **missing**:
- Pre-send validation
- State transition validation
- Message sequence validation
- Integration of validator infrastructure

**Recommendation**: Focus on integrating the existing ProtocolValidator and expanding it with state machine validation before building entirely new validation systems.
