# Tool Name Validation Implementation

This document describes the implementation of the **SEP: Specify Format for Tool Names** in the MCP TypeScript SDK.

## Overview

The Model Context Protocol (MCP) TypeScript SDK now includes comprehensive tool name validation according to the SEP specification. This ensures that tool names follow a standardized format while maintaining backwards compatibility.

## Implementation Details

### Validation Rules

Tool names MUST conform to the following rules:

- **Length**: 1-128 characters (inclusive)
- **Characters**: Only the following characters are allowed:
  - Uppercase and lowercase ASCII letters (A-Z, a-z)
  - Digits (0-9)
  - Underscore (_)
  - Dash (-)
  - Dot (.)
  - Forward slash (/)
- **Case**: Tool names are case-sensitive
- **Restrictions**: No spaces, commas, or other special characters

### Validation Levels

The validation system operates at three levels:

1. **Errors**: Names that violate the core rules (e.g., containing invalid characters)
2. **Warnings**: Names that are technically valid but may cause parsing issues
3. **Success**: Names that fully conform to the specification

### Warning Conditions

Warnings are issued for:

- Names starting or ending with dashes (`-tool-name`)
- Names starting or ending with dots (`.tool.name`)
- Names containing spaces (though these also trigger errors)
- Names containing commas (though these also trigger errors)

## Usage

### Automatic Validation

Tool name validation is automatically applied when registering tools using any of these methods:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({
  name: "my-server",
  version: "1.0.0"
});

// All of these will trigger validation
server.registerTool("valid-tool-name", config, handler);
server.tool("valid-tool-name", config, handler);
```

### Validation Functions

The validation utilities can also be used directly:

```typescript
import { 
  validateToolName, 
  validateAndWarnToolName 
} from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";

// Check validation without side effects
const result = validateToolName("my-tool");
if (result.isValid) {
  console.log("Tool name is valid");
} else {
  console.log("Validation errors:", result.warnings);
}

// Validate and automatically issue warnings/errors
const isValid = validateAndWarnToolName("my-tool");
```

## Examples

### Valid Tool Names

```typescript
// Simple alphanumeric
"getUser"
"user_profile"
"user-profile"

// Hierarchical names
"admin/tools/list"
"user/profile/update"

// Mixed patterns
"DATA_EXPORT_v2.1"
"api.v1.endpoint"
```

### Names That Generate Warnings

```typescript
// Leading/trailing dashes
"-get-user"      // Warning: starts with dash
"get-user-"      // Warning: ends with dash

// Leading/trailing dots
".config"        // Warning: starts with dot
"config."        // Warning: ends with dot
```

### Invalid Names

```typescript
// Contains spaces
"get user"       // Error: contains spaces

// Contains invalid characters
"user@domain"    // Error: contains @
"test,api"       // Error: contains comma
"tool-name!"     // Error: contains !

// Too long
"a".repeat(129)  // Error: exceeds 128 characters
```

## Console Output

The validation system provides detailed feedback through console output:

### Warnings
```
Tool name validation warning for "-warning-tool":
  - Tool name starts or ends with a dash, which may cause parsing issues in some contexts

Consider updating the tool name to conform to the MCP tool naming standard.
See SEP: Specify Format for Tool Names for more details.
```

### Errors
```
Tool name validation failed for "invalid tool name":
  - Tool name contains spaces, which may cause parsing issues
  - Tool name contains invalid characters: " "
  - Allowed characters are: A-Z, a-z, 0-9, underscore (_), dash (-), dot (.), and forward slash (/)

Tool registration will proceed, but this may cause compatibility issues.
```

## Backwards Compatibility

**Important**: This implementation maintains full backwards compatibility:

- Existing tools with non-conforming names continue to work
- Tool registration is never blocked due to validation failures
- Warnings and errors are informational only
- The system gracefully degrades while encouraging best practices

## Testing

The validation system includes comprehensive tests:

```bash
# Run validation tests
npm test -- src/shared/toolNameValidation.test.ts

# Run integration tests
npm test -- src/server/mcp.test.ts --testNamePattern="should validate tool names"
```

## Demo

Run the demo script to see validation in action:

```bash
npx tsx examples/tool-name-validation-demo.ts
```

## Migration Guide

To update existing tool names to conform to the new standard:

1. **Replace spaces** with dashes or underscores:
   - `"get user"` → `"get-user"` or `"get_user"`

2. **Remove invalid characters**:
   - `"api@v1"` → `"api-v1"`
   - `"test,api"` → `"test-api"`

3. **Fix leading/trailing characters**:
   - `"-tool"` → `"tool"`
   - `"config."` → `"config"`

4. **Shorten long names**:
   - Names exceeding 128 characters should be abbreviated

## References

- [SEP: Specify Format for Tool Names](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/SEPs/SEP-0001-tool-names.md)
- [MCP Specification](https://modelcontextprotocol.io/specification/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)