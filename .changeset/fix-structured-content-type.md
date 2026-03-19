---
'@modelcontextprotocol/server': patch
---

fix: allow named interfaces for structuredContent in tool callbacks

Previously, returning a named interface type (e.g., `interface MyResult { data: string }`)
as `structuredContent` in a tool callback caused a TypeScript error because TypeScript
does not allow named interfaces to be assigned to `Record<string, unknown>` index signatures.
Inline object types worked fine, making this an inconsistent developer experience.

The fix introduces a `ToolCallbackResult` type that uses `object` instead of
`Record<string, unknown>` for the `structuredContent` field in the callback return position,
while keeping the Zod schema unchanged for runtime validation.
