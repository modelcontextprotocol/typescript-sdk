# tools

**Start here.** Register tools with `McpServer.registerTool`; the SDK infers the JSON Schema from any Standard-Schema-compatible input (Zod here) and emits `structuredContent` matching `outputSchema`. The client lists tools, inspects schemas and `annotations`, calls them, and
asserts structured output.

```bash
pnpm tsx examples/tools/client.ts
```
