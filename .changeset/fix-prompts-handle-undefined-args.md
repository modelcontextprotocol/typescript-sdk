---
'@modelcontextprotocol/server': patch
---

fix(server): handle undefined args in prompt handlers with all-optional schemas

When a prompt has an argsSchema where all fields are optional, the LLM may omit the arguments entirely (undefined). `validateStandardSchema(undefined)` fails validation. Fix by using `args ?? {}` as the defensive fallback, matching the pattern already applied to tool handlers in PR #1404.
