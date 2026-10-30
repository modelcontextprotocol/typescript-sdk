---
'@modelcontextprotocol/server': patch
---

fix(server): prefix `maxToolInputElements` refusal errors with `Input validation error:`

This makes error messages consistent with the existing pattern at line 374 where `parseResult.error` is also prefixed with `Input validation error:`.
