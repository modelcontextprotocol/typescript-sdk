# Model Context Protocol (MCP) Specification Research

## Research Date: 2025-10-01

## Executive Summary

This document provides comprehensive research on the Model Context Protocol (MCP) specification, focusing on protocol requirements, message format specifications, JSON-RPC 2.0 compliance, validation requirements, and security considerations. The research reveals significant gaps in current validation implementation, particularly around JSON-RPC 2.0 message format validation at the transport/protocol level.

---

## 1. Official Protocol Specification

### Primary Sources

- **Official Specification**: https://modelcontextprotocol.io/specification/2025-06-18
- **GitHub Repository**: https://github.com/modelcontextprotocol/modelcontextprotocol
- **TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk
- **Security Best Practices**: https://modelcontextprotocol.io/specification/draft/basic/security_best_practices

### Protocol Overview

MCP is an open protocol that enables seamless integration between LLM applications and external data sources and tools. The protocol:

- **Built on JSON-RPC 2.0**: All messages between MCP clients and servers MUST follow the JSON-RPC 2.0 specification
- **Stateful Session Protocol**: Focuses on context exchange and sampling coordination between clients and servers
- **Component-Based Architecture**: Defines multiple optional components (resources, prompts, tools, sampling, roots, elicitation)
- **Transport-Agnostic**: Supports multiple transport mechanisms (stdio, SSE, Streamable HTTP, WebSocket)

---

## 2. JSON-RPC 2.0 Compliance Requirements

### Core JSON-RPC 2.0 Specification

Source: https://www.jsonrpc.org/specification

All MCP implementations MUST comply with the JSON-RPC 2.0 specification, which defines three fundamental message types:

#### 2.1 Request Object Requirements

A valid JSON-RPC 2.0 Request **MUST** contain:

1. **`jsonrpc`**: A String specifying the version of the JSON-RPC protocol. **MUST** be exactly `"2.0"`.

2. **`method`**: A String containing the name of the method to be invoked.
   - Method names beginning with `rpc.` are reserved for JSON-RPC internal methods and extensions
   - **MUST NOT** be used for application-specific methods

3. **`params`**: A Structured value (Array or Object) holding parameter values.
   - This member **MAY** be omitted.

4. **`id`**: An identifier established by the Client.
   - **MUST** contain a String, Number, or NULL value if included
   - If not included, the message is assumed to be a **Notification**
   - **MCP Deviation**: The MCP specification states that the ID **MUST NOT** be null

#### 2.2 Response Object Requirements

When an RPC call is made, the Server **MUST** reply with a Response, except for Notifications.

A valid Response **MUST** contain:

1. **`jsonrpc`**: **MUST** be exactly `"2.0"`.

2. **`result`**: This member is **REQUIRED** on success.
   - This member **MUST NOT** exist if there was an error.

3. **`error`**: This member is **REQUIRED** on error.
   - This member **MUST NOT** exist if there was no error.
   - **MUST** contain an error object with:
     - `code` (Number): Integer error code
     - `message` (String): Short error description
     - `data` (Any, optional): Additional error details

4. **`id`**: This member is **REQUIRED**.
   - It **MUST** be the same as the value of the `id` member in the Request Object.
   - If there was an error in detecting the id in the Request object, it MUST be Null.

#### 2.3 Notification Requirements

A Notification is a Request object without an `id` member.

- The receiver **MUST NOT** send a response to a Notification.
- Notifications **MUST NOT** include an `id` member.
- Used for one-way messages that do not expect a response.

#### 2.4 Batch Request Support

JSON-RPC 2.0 supports sending multiple Request objects in an Array:

- MCP implementations **MAY** support sending JSON-RPC batches
- MCP implementations **MUST** support receiving JSON-RPC batches
- The Server **MAY** process batch requests concurrently
- Responses can be returned in any order
- No Response is sent for Notifications in a batch

#### 2.5 Standard Error Codes

The JSON-RPC 2.0 specification defines the following standard error codes:

| Code | Message | Meaning |
|------|---------|---------|
| -32700 | Parse error | Invalid JSON was received by the server |
| -32600 | Invalid Request | The JSON sent is not a valid Request object |
| -32601 | Method not found | The method does not exist / is not available |
| -32602 | Invalid params | Invalid method parameter(s) |
| -32603 | Internal error | Internal JSON-RPC error |
| -32000 to -32099 | Server error | Reserved for implementation-defined server-errors |

---

## 3. MCP Protocol Requirements

### 3.1 Message Format Requirements

All messages between MCP clients and servers **MUST**:

1. Follow the JSON-RPC 2.0 specification
2. Use JSON (RFC 4627) as the data format
3. Include the `jsonrpc: "2.0"` version field
4. Follow the appropriate structure for requests, responses, or notifications

### 3.2 Response Requirements

- Responses **MUST** include the same ID as the request they correspond to
- Either a `result` or an `error` **MUST** be set
- A response **MUST NOT** set both `result` and `error`
- Results **MAY** follow any JSON object structure
- Errors **MUST** include an error code (integer) and message (string) at minimum

### 3.3 Transport Requirements

From the specification:

> Implementers choosing to support custom transport mechanisms must ensure they preserve the JSON-RPC message format and lifecycle requirements defined by MCP.

All implementations **MUST**:
- Support the base protocol and lifecycle management components
- Preserve JSON-RPC message format across all transports
- Support receiving JSON-RPC batches (even if sending batches is not supported)

### 3.4 Core Component Requirements

- **Base Protocol**: All implementations **MUST** support
- **Lifecycle Management**: All implementations **MUST** support
- **Other Components** (Resources, Prompts, Tools, etc.): **MAY** be implemented based on application needs

---

## 4. Validation Requirements

### 4.1 Protocol-Level Validation

Based on the specification and best practices, MCP implementations should rigorously validate:

#### Message Structure Validation

1. **JSON-RPC Version**: Verify `jsonrpc === "2.0"`
2. **Required Fields**: Ensure all required fields are present
3. **Field Types**: Validate that fields have correct types
4. **ID Consistency**: Ensure response IDs match request IDs
5. **Mutual Exclusivity**: Verify responses don't have both `result` and `error`
6. **Notification Structure**: Ensure notifications don't have `id` field

#### Parameter Validation

From the specification:
> Use JSON Schema validation on both client and server sides to catch type mismatches early and provide helpful error messages.

#### Security-Related Validation

From security best practices:
> Servers should rigorously validate incoming MCP messages against the protocol specification (structure, field consistency, recursion depth) to prevent malformed request attacks.

### 4.2 Error Handling Requirements

**Standard JSON-RPC Errors**: Servers should return standard JSON-RPC errors for common failure cases:

- **-32700 (Parse error)**: Invalid JSON received
- **-32600 (Invalid Request)**: Missing required fields or invalid structure
- **-32601 (Method not found)**: Unknown method
- **-32602 (Invalid params)**: Parameter validation failed
- **-32603 (Internal error)**: Server-side processing error

**Error Message Strategy**:
- Parameter validation with detailed error messages
- Error messages should help the LLM understand what went wrong
- Include suggestions for corrective actions

**Timeout Requirements**:
> Implementations should implement appropriate timeouts for all requests, to prevent hung connections and resource exhaustion.

---

## 5. Security Implications of Protocol Validation

### 5.1 Critical Security Requirements

From the official security best practices documentation:

#### Authentication and Authorization

**MUST Requirements**:
- MCP servers that implement authorization **MUST** verify all inbound requests
- MCP Servers **MUST NOT** use sessions for authentication
- MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server
- "Token passthrough" (accepting tokens without validation) is explicitly **FORBIDDEN**

#### Session Security

- MCP servers **MUST** use secure, non-deterministic session IDs
- Generated session IDs (e.g., UUIDs) **SHOULD** use secure random number generators

#### Input/Output Validation

From security guidelines:
> Security for agent-tool protocols must start with strong auth, scoped permissions, and input/output validation. Developers should implement allow-lists, schema validations, and content filters.

### 5.2 Attack Vectors and Mitigation

#### Identified Vulnerabilities

1. **Malformed Request Attacks**
   - **Risk**: Servers that don't validate message structure can be exploited
   - **Mitigation**: Rigorous validation of structure, field consistency, recursion depth

2. **Prompt Injection**
   - **Risk**: AI systems accepting untrusted user input with hidden prompts
   - **Mitigation**: Input validation, content filtering, careful handling of user data
   - **Note**: Modern exploits center on "lethal trifecta": privileged access + untrusted input + exfiltration channel

3. **Confused Deputy Problem**
   - **Risk**: MCP server acts on behalf of wrong principal
   - **Mitigation**: Strict authorization checks, proper token validation

4. **Session Hijacking**
   - **Risk**: Attacker takes over legitimate session
   - **Mitigation**: Secure session ID generation, session binding to user information

5. **OAuth Phishing (Issue #544)**
   - **Risk**: Insufficient authentication mechanisms allow fake MCP servers
   - **Recommendation**: Add "resource" parameter to OAuth flow, validate server addresses
   - **Note**: Security flaws should be addressed "at the protocol level" rather than relying on user awareness

### 5.3 Best Practices for Validation

#### Development Security

- **SAST/SCA**: Build on pipelines implementing Static Application Security Testing and Software Composition Analysis
- **Dependency Management**: Identify and fix known vulnerabilities in dependencies

#### Logging and Monitoring

> Every time the AI uses a tool via MCP, the system should log who/what invoked it, which tool, with what parameters, and what result came back, with logs stored securely.

#### User Consent

From the specification:
> Users must explicitly consent to and understand all data access and operations

Implementations **MUST** obtain explicit user consent before:
- Exposing user data to servers
- Invoking any tools
- Performing LLM sampling

#### Local Server Configuration Safeguards

- Display full command details before execution
- Require explicit user consent
- Highlight potentially dangerous command patterns
- Sandbox server execution
- Restrict system/file system access
- Limit network privileges

---

## 6. Current TypeScript SDK Implementation Analysis

### 6.1 Existing Validation

The TypeScript SDK currently implements:

1. **Zod-based Type Validation**: Uses Zod schemas for runtime type checking
2. **Message Type Guards**: Functions like `isJSONRPCRequest()`, `isJSONRPCResponse()`, etc.
3. **Application-Level Validation**: Input schema validation for tools, resources, and prompts
4. **Error Code Support**: Defines standard JSON-RPC error codes in `ErrorCode` enum

### 6.2 Identified Gaps

#### Critical Issue: Invalid JSON-RPC Validation (Issue #563)

**Problem**: Some invalid JSON-RPC requests do not generate error responses as specified in the JSON-RPC 2.0 specification.

**Example**: A request with an incorrect method property (e.g., `"method_"` instead of `"method"`) returns nothing instead of an error.

**Expected Behavior**:
- For malformed requests: Return error code -32600 (Invalid Request)
- For invalid params: Return error code -32602 (Invalid params)

**Current Limitation**:
- Invalid requests do not reach application error handling
- Developers cannot implement validation logic due to lack of error responses

#### Transport-Level Validation Issues

1. **No Validation at Transport Boundary**: The `Transport` interface doesn't enforce JSON-RPC validation
2. **Protocol Class Assumes Valid Messages**: The `Protocol` class (in `protocol.ts`) uses type guards but doesn't respond with errors for invalid messages
3. **Missing Parse Error Handling**: No handling for -32700 (Parse error) when invalid JSON is received

#### Message Handling in Protocol Class

Looking at `protocol.ts` lines 314-328:

```typescript
this._transport.onmessage = (message, extra) => {
  _onmessage?.(message, extra);
  if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
    this._onresponse(message);
  } else if (isJSONRPCRequest(message)) {
    this._onrequest(message, extra);
  } else if (isJSONRPCNotification(message)) {
    this._onnotification(message);
  } else {
    this._onerror(
      new Error(`Unknown message type: ${JSON.stringify(message)}`),
    );
  }
};
```

**Issue**: When a message doesn't match any type guard, it calls `_onerror()` but doesn't send a JSON-RPC error response back to the sender.

### 6.3 Incomplete Implementation: transport-validator.ts

The file `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/transport-validator.ts` exists but is incomplete:

- Contains a proposal for validation
- Has a `ProtocolValidator` class that wraps Transport
- Implements logging but not actual validation
- The `close()` method throws "Method not implemented"
- No actual protocol checkers are implemented

This suggests validation work was started but not completed.

---

## 7. Recommendations for Implementation

### 7.1 Priority 1: JSON-RPC Message Validation

Implement comprehensive JSON-RPC 2.0 message validation at the transport/protocol boundary:

1. **Validate All Incoming Messages**:
   - Check for valid JSON structure (catch parse errors)
   - Verify `jsonrpc === "2.0"`
   - Validate required fields are present
   - Check field types match specification
   - Ensure proper Request/Response/Notification structure

2. **Return Proper Error Responses**:
   - -32700 for parse errors (invalid JSON)
   - -32600 for invalid request structure (missing/wrong fields)
   - -32601 for method not found
   - -32602 for invalid parameters

3. **Implementation Location**:
   - Option A: At the Transport level (validate before passing to Protocol)
   - Option B: As a Transport wrapper (like proposed `ProtocolValidator`)
   - Option C: In the Protocol class's `onmessage` handler

### 7.2 Priority 2: Security-Focused Validation

1. **Malformed Request Protection**:
   - Validate message structure depth (prevent deeply nested objects)
   - Implement size limits on messages
   - Validate recursion depth

2. **Token Validation**:
   - Ensure proper token validation (no passthrough)
   - Verify token audience and claims
   - Implement proper session binding

3. **Input Sanitization**:
   - Validate all user inputs against schemas
   - Implement content filtering for prompt injection
   - Use allow-lists where appropriate

### 7.3 Priority 3: Comprehensive Testing

1. **JSON-RPC Compliance Tests**:
   - Test all invalid request formats
   - Verify proper error responses
   - Test batch request handling
   - Test notification handling (no responses)

2. **Security Tests**:
   - Test malformed request handling
   - Test deeply nested structures
   - Test oversized messages
   - Test invalid tokens

3. **Transport-Specific Tests**:
   - Test validation across all transport types
   - Ensure consistent behavior

### 7.4 Priority 4: Documentation and Guidelines

1. **Security Documentation**:
   - Document validation requirements for implementers
   - Provide security best practices
   - Include threat model documentation

2. **Error Handling Guide**:
   - Document all error codes
   - Provide examples of proper error responses
   - Include debugging guidance

---

## 8. Related Issues and Discussions

### GitHub Issues

1. **Issue #563** - Invalid JSON RPC requests do not respond with an error
   - https://github.com/modelcontextprotocol/typescript-sdk/issues/563
   - Status: Open
   - Priority: High (directly impacts JSON-RPC compliance)

2. **Issue #544** - The MCP protocol exhibits insufficient security design
   - https://github.com/modelcontextprotocol/modelcontextprotocol/issues/544
   - Concerns: OAuth phishing, protocol-level security
   - Recommendation: Address at protocol level, not just implementation

3. **Various Transport Issues** - Multiple issues related to SSE, Streamable HTTP, and validation errors
   - Indicates validation is a recurring concern across transport implementations

### Security Discussions

Multiple security researchers have identified concerns:
- Prompt injection vulnerabilities
- OAuth security issues
- Token passthrough anti-patterns
- Confused deputy problems

The consensus is that **security must be addressed at the protocol level**, not left to individual implementations.

---

## 9. Conclusion

### Key Findings

1. **JSON-RPC 2.0 Compliance is Mandatory**: MCP explicitly requires full JSON-RPC 2.0 compliance, including proper error handling for invalid messages.

2. **Current Implementation Has Gaps**: The TypeScript SDK does not properly validate JSON-RPC message format at the protocol level, leading to non-compliant behavior (Issue #563).

3. **Security Requires Validation**: Proper protocol-level validation is critical for security, protecting against malformed requests, prompt injection, and other attack vectors.

4. **Incomplete Implementation Exists**: The `transport-validator.ts` file suggests validation work was started but not completed.

### Critical Requirements Summary

**MUST Implement**:
- ✅ JSON-RPC 2.0 message format validation
- ✅ Standard error code responses (-32700, -32600, -32601, -32602, -32603)
- ✅ Proper handling of invalid requests, responses, and notifications
- ✅ Batch request support (receiving)
- ✅ Token validation (no passthrough)
- ✅ Secure session ID generation

**SHOULD Implement**:
- ✅ JSON Schema validation for parameters
- ✅ Recursion depth limits
- ✅ Message size limits
- ✅ Comprehensive error messages
- ✅ Logging and monitoring

**MAY Implement**:
- JSON-RPC batch sending (receiving is MUST)
- Additional validation beyond spec requirements
- Custom transport mechanisms (must preserve JSON-RPC format)

### Next Steps

1. **Design Decision**: Choose validation implementation approach (Transport level, wrapper, or Protocol level)
2. **Implementation**: Build comprehensive JSON-RPC validation with proper error responses
3. **Testing**: Create comprehensive test suite for JSON-RPC compliance
4. **Documentation**: Update docs with validation requirements and security guidelines
5. **Security Review**: Conduct security review of validation implementation

---

## References

### Specifications
- JSON-RPC 2.0 Specification: https://www.jsonrpc.org/specification
- MCP Specification (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18
- MCP Security Best Practices: https://modelcontextprotocol.io/specification/draft/basic/security_best_practices

### Repositories
- MCP Specification Repository: https://github.com/modelcontextprotocol/modelcontextprotocol
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk

### Security Resources
- RedHat MCP Security: https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls
- Cisco MCP Security: https://community.cisco.com/t5/security-blogs/ai-model-context-protocol-mcp-and-security/ba-p/5274394
- Writer MCP Security: https://writer.com/engineering/mcp-security-considerations/
- Pillar Security MCP Risks: https://www.pillar.security/blog/the-security-risks-of-model-context-protocol-mcp
- Simon Willison on MCP Prompt Injection: https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
- Microsoft MCP Security: https://techcommunity.microsoft.com/blog/microsoftdefendercloudblog/plug-play-and-prey-the-security-risks-of-the-model-context-protocol/4410829
- Windows MCP Security Architecture: https://blogs.windows.com/windowsexperience/2025/05/19/securing-the-model-context-protocol-building-a-safer-agentic-future-on-windows/

### Related Issues
- TypeScript SDK Issue #563: https://github.com/modelcontextprotocol/typescript-sdk/issues/563
- MCP Issue #544: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/544
- Invariant GitHub MCP Vulnerability: https://invariantlabs.ai/blog/mcp-github-vulnerability

---

## Appendix: Current TypeScript SDK Code Structure

### Relevant Files
- `/src/types.ts` - JSON-RPC type definitions and Zod schemas
- `/src/shared/protocol.ts` - Protocol class implementing message handling
- `/src/shared/transport.ts` - Transport interface definition
- `/src/shared/transport-validator.ts` - Incomplete validation implementation
- Various transport implementations (stdio, sse, streamableHttp, websocket)

### Type Definitions (from types.ts)

```typescript
// JSON-RPC Version
export const JSONRPC_VERSION = "2.0";

// Error Codes
export enum ErrorCode {
  // SDK error codes
  ConnectionClosed = -32000,
  RequestTimeout = -32001,

  // Standard JSON-RPC error codes
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

// Type Guards
export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest =>
  JSONRPCRequestSchema.safeParse(value).success;

export const isJSONRPCNotification = (value: unknown): value is JSONRPCNotification =>
  JSONRPCNotificationSchema.safeParse(value).success;

export const isJSONRPCResponse = (value: unknown): value is JSONRPCResponse =>
  JSONRPCResponseSchema.safeParse(value).success;

export const isJSONRPCError = (value: unknown): value is JSONRPCError =>
  JSONRPCErrorSchema.safeParse(value).success;
```

### Current Message Handling (from protocol.ts, lines 314-328)

```typescript
this._transport.onmessage = (message, extra) => {
  _onmessage?.(message, extra);
  if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
    this._onresponse(message);
  } else if (isJSONRPCRequest(message)) {
    this._onrequest(message, extra);
  } else if (isJSONRPCNotification(message)) {
    this._onnotification(message);
  } else {
    this._onerror(
      new Error(`Unknown message type: ${JSON.stringify(message)}`),
    );
  }
};
```

**Gap**: When message doesn't match any type, it calls `_onerror()` but doesn't send a proper JSON-RPC error response (-32600) back to the sender.

---

*End of Research Document*
