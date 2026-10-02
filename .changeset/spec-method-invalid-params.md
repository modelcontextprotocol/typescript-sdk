---
'@modelcontextprotocol/sdk': patch
---

A request whose params fail the schema it was registered with (for example `prompts/get` without a `name`, `logging/setLevel` with an unknown level, or `tools/call` with a non-string `name`) is now answered with `-32602` Invalid params instead of `-32603` Internal error. The
message reads `Invalid params for <method>: …`.
