---
'@modelcontextprotocol/sdk': patch
---

`tools/call` and `prompts/get` without `arguments` no longer fail with "Invalid arguments" when every argument of the tool or prompt is optional. A missing `arguments` is now validated as `{}`, so a tool whose whole `inputSchema` is wrapped (`.optional()`, `.default(...)`, a
`z.preprocess` fallback) no longer sees `undefined`: its handler gets `{}`, a default on the whole schema is not applied, and a required field inside it is reported as missing.
