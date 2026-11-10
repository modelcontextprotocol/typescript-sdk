---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Inline local `$ref` pointers in tool `inputSchema` so the advertised schemas are self-contained. Several MCP clients and model integrations mishandle or reject `$ref`: some send a referenced object parameter as a string, others reject any ref outside `#/$defs/`. Inlined schemas are accepted everywhere. Recursive schemas are handled gracefully: cyclic `$ref` pointers are left in place with only their `$defs` entries preserved, while all non-cyclic refs are fully inlined. Inputs the helper cannot fully resolve (a malformed `$defs`/`definitions` container, or a local `$ref` that isn't a plain top-level def name) are never made worse: the original containers are kept so every remaining `$ref` still resolves. Hand-authored schemas from `fromJsonSchema()` are advertised unchanged. Because fields of registered types are now reachable through `properties`, an `x-mcp-header` declared on such a field is now valid under SEP-2243: the tool is listed by Streamable HTTP clients and the header is mirrored and validated.
