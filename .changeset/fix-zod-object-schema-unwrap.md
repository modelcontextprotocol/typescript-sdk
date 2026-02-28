---
"@modelcontextprotocol/sdk": patch
---

fix(server): auto-unwrap z.object() schemas passed to server.tool()

When `z.object({...})` was passed as the `inputSchema` argument to `server.tool()`,
the SDK would silently interpret it as `ToolAnnotations` instead of an input schema,
resulting in the tool being registered with empty parameters. Arguments passed to the
tool would be stripped without any error.

Added `extractZodObjectShape()` that detects ZodObject schemas (both Zod v3 and v4)
and extracts their raw shape for proper registration. Tools using the idiomatic
`z.object({ name: z.string() })` form now work identically to the raw shape form
`{ name: z.string() }`.

Fixes #1291
