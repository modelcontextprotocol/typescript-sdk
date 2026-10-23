---
'@modelcontextprotocol/core-internal': patch
---

Expand RFC 6570 prefix-operator expressions as the RFC specifies. A non-exploded list variable under `.` or `/` now joins its values with `,` (`{.list}` → `.red,green,blue`, `{/list}` → `/red,green,blue`) while the exploded form keeps the operator separator. A multi-variable expression (`{x,half,y}`, `{.who,who}`, `{/who,dub}`, `{#x,y}`) now percent-encodes every value, separates them with the operator's separator, and applies the operator's prefix once, instead of emitting the raw values joined with `,` — which produced URIs containing spaces and unencoded `/`.
