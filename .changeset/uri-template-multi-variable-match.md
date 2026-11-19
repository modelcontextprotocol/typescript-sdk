---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Match multi-variable URI template expressions like `{userId,format}`.

`UriTemplate.expand` joins a multi-name expansion with commas, as RFC 6570 §3.2.2
requires, but `match` emitted a single regex capture per part and assigned the whole
captured run to `part.name` — the first name only. The pattern for the bare operator,
`([^/,]+)`, also excludes the comma that `expand` had just written, so the URI failed to
match at all and `match` returned `null`.

`partToRegExp` now emits one capture per name for a multi-name part, with a literal comma
between them, mirroring `expandPart`. The `/`, `.` and `#` operators keep their literal
prefix on the first capture; the bare and reserved forms sit at the current position.
Single-name parts and the `?` / `&` query forms are untouched.

The visible effect is in `McpServer`: a resource registered against a template such as
`data://users/{userId,format}` never matched, so its handler was unreachable and the
`resources/read` was answered as unknown.
