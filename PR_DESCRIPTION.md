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
// Environment-based enabling
server.registerTool("debug-tool", {
  description: "Development debugging utilities",
  enabled: process.env.NODE_ENV === "development"
}, handler);

// Permission-based enabling
server.registerTool("admin-command", {
  description: "Administrative operations", 
  enabled: user.hasRole("admin")
}, handler);

// Pattern-based enabling with multimatch
import multimatch from 'multimatch';
const isEnabled = (name: string) => multimatch([name], ENABLED_PATTERNS).length > 0;

server.registerTool("file-operations", {
  enabled: isEnabled("file-operations")
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

**Comprehensive Documentation Added:**
- Basic usage examples (environment variables, feature flags)
- Advanced pattern-based enabling with multimatch library (simpler than minimatch for this use case)
- Clear migration path for existing code
- Security considerations and best practices

**Real-world Use Cases:**
```bash
# Enable all tools
ENABLED_TOOLS="*"

# Enable only file and user read operations  
ENABLED_TOOLS="file-*,user-get*"

# Enable only debug tools in development
ENABLED_TOOLS="debug-*"

# Disable all tools (testing/security)
ENABLED_TOOLS=""
```

**Advanced Pattern Example:**
```typescript
import multimatch from 'multimatch';

const ENABLED_TOOL_PATTERNS = process.env.ENABLED_TOOLS?.split(',') || ['*'];
const isEnabled = (toolName: string) => multimatch([toolName], ENABLED_TOOL_PATTERNS).length > 0;

// Register tools with pattern-based enabling
server.registerTool("file-read", {
  description: "Read file contents",
  enabled: isEnabled("file-read")
}, handler);

server.registerTool("admin-delete-user", {
  description: "Delete user account", 
  enabled: isEnabled("admin-delete-user")
}, handler);
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

This change enables:
- **Cleaner architecture** - no more wrapper functions or conditional registration
- **Better security** - easy disabling of sensitive operations
- **Flexible deployment** - same codebase, different tool availability per environment
- **Improved UX** - users only see tools they can actually use
- **Future extensibility** - foundation for more advanced tool management features

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