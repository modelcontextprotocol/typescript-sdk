---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Raw-shape `inputSchema`/`outputSchema`/`argsSchema` failures now surface at registration time instead of crashing `tools/list` later. Shapes whose field schemas come from a different zod build than the SDK bundles (e.g. an application's own zod 4.0/4.1 instance) previously
registered fine and then threw `[toJSONSchema]: Non-representable type encountered` when listing; they now throw an actionable `TypeError` from `registerTool`/`registerPrompt`. Shapes mixing zod v3 and v4 fields throw `Error('Mixed Zod versions detected in object shape.')` — the
same registration-time error v1 threw — instead of being misreported as all-v3. The all-v3 error message now also mentions the `fromJsonSchema()` alternative.
