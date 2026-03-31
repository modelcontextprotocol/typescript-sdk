---
'@modelcontextprotocol/sdk': patch
---

Prioritize `error.issues[].message` over `error.message` in `getParseErrorMessage` so custom Zod error messages surface correctly. In Zod v4, `error.message` is a JSON blob of all issues, not a readable string.
