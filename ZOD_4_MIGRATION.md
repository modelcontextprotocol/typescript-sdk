# Zod 4 Support

This SDK now supports both Zod 3 and Zod 4 seamlessly.

## Installation

### With Zod 3 (Current Default)

```bash
npm install @modelcontextprotocol/sdk zod@^3.23.8 zod-to-json-schema@^3.24.1
```

### With Zod 4

```bash
npm install @modelcontextprotocol/sdk zod@^4.0.0
```

Note: `zod-to-json-schema` is **not needed** with Zod 4, as Zod 4 has native JSON Schema support via `z.toJSONSchema()`.

## How It Works

The SDK automatically detects which version of Zod you're using:

- **Zod 4**: Uses the native `z.toJSONSchema()` function for optimal performance
- **Zod 3**: Falls back to the `zod-to-json-schema` library (must be installed)

This is handled transparently by the SDK - you don't need to change your code when upgrading from Zod 3 to Zod 4.

## Migration from Zod 3 to Zod 4

If you're currently using Zod 3 and want to upgrade to Zod 4:

1. **Update your dependencies:**

    ```bash
    npm install zod@^4.0.0
    npm uninstall zod-to-json-schema  # Optional, no longer needed
    ```

2. **Review Zod 4 breaking changes** that may affect your application code (not the MCP SDK itself):
    - See [Zod 4 Migration Guide](https://zod.dev/v4)
    - Most common changes:
        - `z.string().email()` → `z.email()` (top-level function)
        - `.default()` behavior changed (use `.prefault()` for old behavior)
        - Error customization API changed (`message` → `error`)

3. **Test your application** to ensure schema definitions work as expected

## Compatibility Notes

- The SDK maintains **full backwards compatibility** with Zod 3
- You can upgrade to Zod 4 at your own pace
- Both versions are fully supported and tested

## Examples

Your existing code works with both versions:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server';
import { z } from 'zod';

const server = new McpServer({
    name: 'example-server',
    version: '1.0.0'
});

// This works with both Zod 3 and Zod 4
server.tool(
    'greet',
    'Greets a person',
    {
        name: z.string(),
        age: z.number().optional()
    },
    async ({ name, age }) => ({
        content: [
            {
                type: 'text',
                text: `Hello ${name}${age ? `, you are ${age} years old` : ''}!`
            }
        ]
    })
);
```

## Troubleshooting

### "zod-to-json-schema is required but not installed"

If you see this error while using Zod 3, install the missing dependency:

```bash
npm install zod-to-json-schema@^3.24.1
```

This dependency is only needed for Zod 3. Zod 4 does not require it.

## Version Support

- **Zod 3**: `^3.23.8` (requires `zod-to-json-schema`)
- **Zod 4**: `^4.0.0` (native JSON Schema support)
