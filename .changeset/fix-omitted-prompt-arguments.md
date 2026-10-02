---
'@modelcontextprotocol/server': patch
---

`prompts/get` without `arguments` no longer fails with "Invalid arguments" when every argument of the prompt is optional. A missing `arguments` is now validated as `{}`, as it already is for `tools/call`, so a top-level `.optional()` or `.default(...)` on `argsSchema` no longer sees `undefined`.
