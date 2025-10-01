# GitHub Issue #876 Analysis: SSE Connection 5-Minute Timeout

## Issue Summary

**Problem**: SSE (Server-Sent Events) connections always close after 5 minutes, despite attempts to configure longer timeouts.

**Root Cause**: Operating system-level network connection timeouts kill inactive connections after 5 minutes. This is an OS-level limitation, not an application-level issue.

**User's Experience**: 
- The user reported that `res.on('close')` is triggered after exactly 5 minutes
- They attempted to set a longer timeout using `callTool(xx, undefined, {timeout: 20mins})` but this did not prevent the 5-minute disconnect
- The timeout configuration did not work as expected because the OS kills the connection at the network layer

## Technical Details from GitHub Issue

1. **The Problem**: SSE connections terminate after 5 minutes of inactivity
2. **Failed Solution**: Setting application-level timeouts (e.g., `{timeout: 20mins}`) doesn't prevent OS-level network timeouts
3. **Provided Solution**: MCP team member (antonpk1) provided a comprehensive workaround

## Workaround Solution Provided

**Key Insight**: Send periodic "heartbeat" messages to keep the connection alive and prevent OS timeout.

**Implementation Strategy**:
1. Send regular "notifications/progress" messages during long-running operations
2. Use periodic notifications (e.g., every 30 seconds) to maintain connection activity
3. Successfully demonstrated a 20-minute task with periodic progress updates

**Sample Code Pattern** (from the GitHub issue):
- Implement periodic progress notifications to prevent connection timeout
- Send notifications every 30 seconds during long operations
- This keeps the SSE connection active and prevents the 5-minute OS timeout

## Current SDK Implementation Analysis

### Timeout Handling in Protocol Layer

From `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/protocol.ts`:

1. **Default Timeout**: `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (60 seconds)
2. **Request Options**: Support for timeout configuration:
   - `timeout?: number` - Request-specific timeout in milliseconds
   - `resetTimeoutOnProgress?: boolean` - Reset timeout when progress notifications are received
   - `maxTotalTimeout?: number` - Maximum total time regardless of progress

3. **Progress Support**: The SDK has built-in support for progress notifications:
   - `onprogress?: ProgressCallback` - Callback for progress notifications
   - `ProgressNotification` handling in the protocol layer
   - Automatic timeout reset when `resetTimeoutOnProgress` is enabled

### SSE Implementation

From `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/sse.ts` and `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/server/sse.ts`:

1. **Client SSE Transport**: Uses EventSource API for receiving messages, HTTP POST for sending
2. **Server SSE Transport**: Sends messages via SSE stream, receives via HTTP POST handlers
3. **No Built-in Keepalive**: The current SSE implementation does not include automatic keepalive/heartbeat functionality

### Current Client Implementation Note

In `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.ts` (line 436):
```typescript
console.error("Calling tool", params, options, options?.timeout);
```
This debug log shows the client does receive and process timeout options.

## Gap Analysis

**What's Missing**: 
1. **No automatic keepalive mechanism** in SSE transport implementations
2. **No built-in progress notification sending** for long-running operations
3. **Documentation** about the 5-minute OS timeout limitation and workarounds

**What Exists**:
1. **Progress notification support** in the protocol layer
2. **Timeout reset on progress** functionality (`resetTimeoutOnProgress`)
3. **Flexible timeout configuration** per request

## Recommended Implementation

Based on the GitHub issue resolution, the SDK should:

1. **Add automatic keepalive option** to SSE transport classes
2. **Provide helper utilities** for sending periodic progress notifications
3. **Document the 5-minute limitation** and workaround patterns
4. **Include example code** showing how to implement progress notifications for long-running operations

## Impact Assessment

- **Current State**: Users experience unexpected disconnects after 5 minutes
- **Workaround Exists**: Manual progress notification implementation works
- **SDK Enhancement Needed**: Built-in keepalive and better documentation would improve developer experience

## Test Coverage

The test suite in `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/protocol.test.ts` includes:
- Timeout error handling tests
- Progress notification preservation tests
- But no specific tests for long-duration connections or keepalive functionality

This analysis confirms that GitHub issue #876 identifies a real OS-level limitation that affects SSE connections, and the MCP team has provided a viable workaround using progress notifications to maintain connection activity.