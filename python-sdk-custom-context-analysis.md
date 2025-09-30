# Python MCP SDK Custom Context Analysis

## Executive Summary

The Python MCP SDK **lacks built-in support for custom context injection** similar to what was added to the TypeScript SDK. While it does provide access to the raw HTTP request object in handlers, there's no clean mechanism to inject processed custom context (e.g., user authentication data, permissions, tenant information) that can be accessed by tool/prompt/resource handlers.

## Current State of Python SDK

### Context Architecture

1. **RequestContext Class** (`src/mcp/shared/context.py`):
```python
@dataclass
class RequestContext(Generic[SessionT, LifespanContextT, RequestT]):
    request_id: RequestId
    meta: RequestParams.Meta | None
    session: SessionT
    lifespan_context: LifespanContextT
    request: RequestT | None = None  # This is where custom data could go
```

2. **Context Access in Handlers**:
```python
@app.call_tool()
async def my_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
    ctx = app.request_context  # Access context
    # ctx.request contains the Starlette Request object
    # ctx.session, ctx.request_id, ctx.lifespan_context are available
```

3. **Transport Layer** (`src/mcp/server/streamable_http.py`):
   - Line 385-386: Creates `ServerMessageMetadata` with `request_context=request`
   - The raw Starlette Request object is passed as the context
   - No mechanism to inject processed custom data

### Key Differences from TypeScript SDK

| Aspect | TypeScript SDK | Python SDK |
|--------|---------------|------------|
| Custom Context Method | `transport.setCustomContext()` | None |
| Context Access | `extra.customContext` | `app.request_context.request` |
| Context Type | Arbitrary object | Starlette Request object |
| Processing | Transport can inject processed data | Only raw HTTP request available |
| Type Safety | Can define custom types | Limited to Request type |

## Problems with Current Python SDK

1. **No Clean Context Injection**: Handlers receive the raw HTTP request but there's no way to inject processed context
2. **Authentication Complexity**: Every handler would need to extract and validate authentication from headers
3. **No Abstraction**: Tight coupling to HTTP transport (Starlette Request)
4. **Repeated Logic**: Authentication/authorization logic must be duplicated in each handler
5. **Limited Flexibility**: Can't easily inject tenant data, user permissions, or other contextual information

## Proposed Fix Plan

### Option 1: Minimal Change - Add Custom Context Field (Recommended)

Add a `custom_context` field to `RequestContext` and provide a way for transports to set it:

#### 1. Update RequestContext (`src/mcp/shared/context.py`):
```python
@dataclass
class RequestContext(Generic[SessionT, LifespanContextT, RequestT]):
    request_id: RequestId
    meta: RequestParams.Meta | None
    session: SessionT
    lifespan_context: LifespanContextT
    request: RequestT | None = None
    custom_context: Any | None = None  # NEW: Custom context field
```

#### 2. Update ServerMessageMetadata (`src/mcp/shared/message.py`):
```python
@dataclass
class ServerMessageMetadata:
    related_request_id: RequestId | None = None
    request_context: Any | None = None
    custom_context: Any | None = None  # NEW: Custom context field
```

#### 3. Update StreamableHTTPServerTransport (`src/mcp/server/streamable_http.py`):
Add a method to set custom context and use it in request handling:

```python
class StreamableHTTPServerTransport:
    def __init__(self, ...):
        # ... existing code ...
        self._custom_context: Any | None = None
    
    def set_custom_context(self, context: Any) -> None:
        """Set custom context to be passed to handlers."""
        self._custom_context = context
    
    async def _handle_post_request(self, ...):
        # ... existing code ...
        # Line ~385, update metadata creation:
        metadata = ServerMessageMetadata(
            request_context=request,
            custom_context=self._custom_context  # NEW: Include custom context
        )
```

#### 4. Update Server (`src/mcp/server/lowlevel/server.py`):
Pass custom context to RequestContext:

```python
async def _handle_request(self, ...):
    # ... existing code ...
    # Extract custom context from metadata
    custom_context = None
    if message.message_metadata and isinstance(message.message_metadata, ServerMessageMetadata):
        request_data = message.message_metadata.request_context
        custom_context = message.message_metadata.custom_context  # NEW
    
    # Set context with custom data
    token = request_ctx.set(
        RequestContext(
            message.request_id,
            message.request_meta,
            session,
            lifespan_context,
            request=request_data,
            custom_context=custom_context  # NEW: Pass custom context
        )
    )
```

#### 5. Add Middleware Support in StreamableHTTPSessionManager:
```python
class StreamableHTTPSessionManager:
    def __init__(self, ..., context_middleware: Callable[[Request], Awaitable[Any]] | None = None):
        self.context_middleware = context_middleware
    
    async def _handle_stateful_request(self, ...):
        # ... existing code ...
        # Before creating transport, process context
        custom_context = None
        if self.context_middleware:
            custom_context = await self.context_middleware(request)
        
        # Pass custom context to transport
        http_transport = StreamableHTTPServerTransport(...)
        if custom_context:
            http_transport.set_custom_context(custom_context)
```

### Option 2: Full Middleware Architecture

Create a more comprehensive middleware system similar to Express.js or FastAPI:

1. Define middleware interface
2. Allow chaining of middleware functions
3. Support both sync and async middleware
4. Provide built-in authentication middleware

This is more complex but provides greater flexibility.

### Option 3: Subclass-Based Approach

Allow users to subclass `StreamableHTTPServerTransport` and override context extraction:

```python
class CustomHTTPTransport(StreamableHTTPServerTransport):
    async def extract_context(self, request: Request) -> Any:
        # Custom logic to extract and process context
        api_key = request.headers.get("X-API-Key")
        return await fetch_user_context(api_key)
```

## Implementation Priority

1. **Phase 1**: Implement Option 1 (Minimal Change) - Adds basic custom context support
2. **Phase 2**: Add helper utilities for common patterns (auth extraction, validation)
3. **Phase 3**: Consider full middleware architecture if needed

## Example Usage After Fix

```python
# Server setup with custom context
async def context_middleware(request: Request) -> dict:
    """Extract and validate user context from request."""
    api_key = request.headers.get("X-API-Key")
    if not api_key:
        return None
    
    # Fetch user data from database
    user_data = await fetch_user_by_api_key(api_key)
    return {
        "user_id": user_data["id"],
        "email": user_data["email"],
        "permissions": user_data["permissions"],
        "organization_id": user_data["org_id"]
    }

# Initialize session manager with middleware
session_manager = StreamableHTTPSessionManager(
    app=app,
    context_middleware=context_middleware
)

# In tool handlers
@app.call_tool()
async def my_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
    ctx = app.request_context
    user_context = ctx.custom_context  # Access custom context
    
    if not user_context:
        return [types.TextContent(type="text", text="Not authenticated")]
    
    if "admin" not in user_context.get("permissions", []):
        return [types.TextContent(type="text", text="Permission denied")]
    
    # Proceed with tool logic
    return [types.TextContent(
        type="text", 
        text=f"Hello {user_context['email']}!"
    )]
```

## Benefits of Proposed Solution

1. **Clean Separation**: Authentication logic separated from business logic
2. **Type Safety**: Can use TypedDict or dataclasses for context types
3. **Reusability**: Context extraction logic in one place
4. **Transport Agnostic**: Works with any transport that supports context
5. **Backward Compatible**: Existing code continues to work
6. **Minimal Changes**: Small, focused changes to core SDK

## Migration Path

1. Changes are backward compatible - existing handlers continue working
2. New `custom_context` field is optional
3. Gradual adoption - handlers can migrate to use custom context as needed
4. Documentation and examples to guide migration

## Testing Strategy

1. Unit tests for context injection and retrieval
2. Integration tests with authentication middleware
3. Example server demonstrating custom context usage
4. Performance tests to ensure no regression

## Conclusion

The Python MCP SDK currently lacks the custom context injection capability that was recently added to the TypeScript SDK. The proposed fix (Option 1) provides a minimal, backward-compatible solution that brings feature parity between the two SDKs while maintaining the Python SDK's design principles.

The implementation is straightforward and can be completed in a few hours, with most of the work involving:
1. Adding fields to existing dataclasses
2. Passing context through the call chain
3. Adding a context middleware hook
4. Creating examples and documentation

This would enable Python MCP servers to properly handle authentication, multi-tenancy, and permission-based access control in a clean, maintainable way.