# OutputSchema Support Implementation

This document summarizes the changes made to support tools with `outputSchema` in the MCP TypeScript SDK.

## Changes Made

### Server-Side Changes

#### 1. Tool Registration (mcp.ts)

- Added support for parsing and storing `outputSchema` when registering tools
- Updated the `tool()` method to handle outputSchema parameter in various overload combinations
- Added new overloads to support tools with outputSchema:
  ```typescript
  tool<Args extends ZodRawShape>(
    name: string,
    paramsSchema: Args,
    outputSchema: Tool["outputSchema"],
    cb: ToolCallback<Args>,
  ): RegisteredTool;
  ```

#### 2. Tool Listing

- Modified `ListToolsResult` handler to include outputSchema in tool definitions
- Only includes outputSchema in the response if it's defined for the tool

#### 3. Tool Execution

- Updated `CallToolRequest` handler to validate structured content based on outputSchema
- Added automatic backward compatibility:
  - If a tool has outputSchema and returns `structuredContent` but no `content`, the server automatically generates a text representation
  - This ensures compatibility with clients that don't support structured content
- Added validation to ensure:
  - Tools with outputSchema must return structuredContent (unless error)
  - Tools without outputSchema must not return structuredContent
  - Tools without outputSchema must return content

#### 4. Backward Compatibility

The implementation maintains full backward compatibility:
- Tools without outputSchema continue to work as before
- Tools with outputSchema can optionally provide both `structuredContent` and `content`
- If only `structuredContent` is provided, `content` is auto-generated as JSON

### Client-Side Changes

#### 1. Schema Caching and Validation (index.ts)

- Added `_cachedTools` and `_cachedToolOutputSchemas` maps to cache tool definitions and their parsed Zod schemas
- The client converts JSON Schema to Zod schema using the `json-schema-to-zod` library for runtime validation
- Added dependency: `json-schema-to-zod` for converting JSON schemas to Zod schemas

#### 2. Tool Listing

- Modified `listTools` to parse and cache output schemas:
  - When a tool has an outputSchema, the client converts it to a Zod schema
  - Schemas are cached for validation during tool calls
  - Handles errors gracefully with warning logs if schema parsing fails

#### 3. Tool Execution

- Enhanced `callTool` method with comprehensive validation:
  - Tools with outputSchema must return `structuredContent` (validates this requirement)
  - Tools without outputSchema must not return `structuredContent`
  - Validates structured content against the cached Zod schema
  - Provides detailed error messages when validation fails

#### 4. Error Handling

The client throws `McpError` with appropriate error codes:
- `ErrorCode.InvalidRequest` when required structured content is missing or unexpected
- `ErrorCode.InvalidParams` when structured content doesn't match the schema

### Testing

#### Server Tests

Added comprehensive test suite (`mcp-outputschema.test.ts`) covering:
- Tool registration with outputSchema
- ListToolsResult including outputSchema
- Tool execution with structured content
- Automatic backward compatibility behavior
- Error cases and validation

#### Client Tests

Added tests in `index.test.ts` covering:
- Validation of structured content against output schemas
- Error handling when structured content doesn't match schema
- Error handling when tools with outputSchema don't return structured content
- Error handling when tools without outputSchema return structured content
- Complex JSON schema validation including nested objects, arrays, and strict mode
- Validation of additional properties when `additionalProperties: false`

### Examples

Created two example servers:
1. `outputSchema.ts` - Using the low-level Server API
2. `mcpServerOutputSchema.ts` - Using the high-level McpServer API

These examples demonstrate:
- Tools with structured output (weather data, CSV processing, BMI calculation)
- Tools that return both structured and readable content
- Traditional tools without outputSchema for comparison

## API Usage

### Registering a tool with outputSchema:

```typescript
server.tool(
  "calculate_bmi",
  "Calculate BMI given height and weight",
  {
    height_cm: z.number(),
    weight_kg: z.number()
  },
  {
    type: "object",
    properties: {
      bmi: { type: "number" },
      category: { type: "string" }
    },
    required: ["bmi", "category"]
  },
  async ({ height_cm, weight_kg }) => {
    // Calculate BMI...
    return {
      structuredContent: {
        bmi: calculatedBmi,
        category: bmiCategory
      }
    };
  }
);
```

### Tool callback return values:

- For tools with outputSchema: Return `{ structuredContent: {...} }`
- For backward compatibility: Optionally include `{ structuredContent: {...}, content: [...] }`
- For tools without outputSchema: Return `{ content: [...] }` as before

## Implementation Summary

### Key Design Decisions

1. **Backward Compatibility**: The server automatically generates `content` from `structuredContent` for clients that don't support structured output
2. **Schema Validation**: The client validates all structured content against the tool's output schema using Zod
3. **Caching**: The client caches parsed schemas to avoid re-parsing on every tool call
4. **Error Handling**: Both client and server validate the correct usage of `structuredContent` vs `content` based on whether a tool has an outputSchema

### Implementation Notes

1. **Server Side**:
   - Automatically handles backward compatibility by serializing structuredContent to JSON
   - Validates that tools properly use structuredContent vs content based on their outputSchema
   - All existing tools continue to work without changes

2. **Client Side**:
   - Converts JSON Schema to Zod schemas for runtime validation
   - Caches schemas for performance
   - Provides detailed validation errors when structured content doesn't match schemas
   - Enforces proper usage of structuredContent based on outputSchema presence

3. **Compatibility**:
   - The implementation follows the spec requirements
   - Maintains full backward compatibility
   - Provides a good developer experience with clear error messages
   - Ensures both old and new clients can work with servers that support outputSchema