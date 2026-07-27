---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Make zod-to-JSON-Schema conversion wire-truthful for tool schemas. A `z.date()` (or any
unrepresentable type) in a registered tool's schema no longer throws during conversion and
fails the entire `tools/list` response — dates are advertised as `{type: 'string', format:
'date-time'}` (the shape `JSON.stringify` actually produces), and other unrepresentable
types degrade to an unconstrained schema. Output schemas no longer advertise constraints the
server doesn't enforce on the raw `structuredContent` it ships: `.default()`-carrying fields
are dropped from `required`, and `additionalProperties: false` is dropped for plain
`z.object()` (kept for `z.strictObject()`), so validating clients no longer reject legitimate
tool results.
