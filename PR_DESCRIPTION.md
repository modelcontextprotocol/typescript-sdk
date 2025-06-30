# 🚀 Add Dynamic Tool Enabling Support

## 📋 Summary
This PR introduces the ability to conditionally enable/disable tools during registration via an optional `enabled` parameter in the `registerTool` configuration. This addresses the need for dynamic tool management based on environment variables, feature flags, permissions, or other runtime conditions.

## 🎯 Motivation

**Why is this change needed?**

Many MCP server implementations require conditional tool availability based on:
- **Environment-specific features** (debug tools only in development)
- **Permission-based access control** (admin tools for authorized users)
- **Feature flags** (experimental tools behind feature toggles)
- **Configuration-driven setup** (enabling only specific tool categories)
- **Security requirements** (disabling potentially dangerous operations)

Currently, developers must implement workarounds like wrapper functions or conditional registration logic, making code less clean and maintainable.

## ✨ What's Changed

### Core Implementation
- **Added `enabled?: boolean` parameter** to `registerTool` config object
- **Updated `_createRegisteredTool`** to accept enabled state with default `true`
- **Maintained 100% backwards compatibility** - existing code continues to work unchanged
- **Follows existing patterns** - uses the established config object approach

### New Capabilities
```typescript
// Conditional tool registration based on runtime conditions
server.registerTool("debug-tool", {
  enabled: process.env.NODE_ENV === "development"
}, handler);

server.registerTool("admin-tool", {
  enabled: user.hasRole("admin") 
}, handler);
```

## 🔧 Technical Details

**Minimal Implementation**
- Only 2 methods modified: `_createRegisteredTool` and `registerTool`
- Zero breaking changes - all existing tools default to `enabled: true`
- Follows existing tool lifecycle patterns (enable/disable methods remain unchanged)
- Consistent with existing resource and prompt enabled functionality

**When `enabled: false`:**
- Tool doesn't appear in `tools/list` responses
- Tool calls return "tool not found" errors
- Dynamic enabling/disabling still works via `.enable()/.disable()` methods

## 📚 Documentation & Examples

**Documentation Added:**
- Basic usage examples (environment variables, permissions)
- Clear migration path for existing code

**Common Use Cases:**
```typescript
// Environment-based
enabled: process.env.NODE_ENV === "development"

// Permission-based  
enabled: user.hasRole("admin")

// Feature flags
enabled: features.isEnabled("experimental-tools")
```

## ✅ Testing

- **Added comprehensive test coverage** for enabled/disabled states
- **Verified backwards compatibility** - existing tests pass unchanged
- **Tested dynamic state changes** via enable/disable methods
- **Validated tool listing behavior** with mixed enabled states

## 🔄 Migration Path

**Existing Code:** No changes required
```typescript
server.registerTool("my-tool", { description: "..." }, handler);
// ✅ Still works - defaults to enabled: true
```

**New Code:** Opt-in enabled control
```typescript
server.registerTool("my-tool", { 
  description: "...",
  enabled: shouldEnableTool() 
}, handler);
// ✅ New capability available when needed
```

## 🎯 Impact

- **Cleaner architecture** - no conditional registration logic
- **Better security** - disable sensitive operations based on context
- **Flexible deployment** - same code, different tools per environment

## 📝 Checklist

- [x] Implementation follows existing code patterns
- [x] Backwards compatibility maintained
- [x] Documentation updated with examples
- [x] Test coverage added
- [x] No breaking changes
- [x] Security considerations documented
- [x] Performance impact: minimal (single boolean check)

---

**Type:** Enhancement  
**Breaking Change:** No  
**Backwards Compatible:** Yes

This enhancement provides immediate value while maintaining the stability and simplicity that makes MCP TypeScript SDK great to work with. 