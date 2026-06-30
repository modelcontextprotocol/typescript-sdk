---
'@modelcontextprotocol/codemod': patch
---

The explicit-`undefined` result-schema removal now requires the same proof as the schema-identifier path: `request()` calls must carry a provably literal spec method, and `callTool()` calls whose first argument is a primitive are left alone. Previously, any file importing an MCP package could have the middle argument deleted from an unrelated `.request()` / `.callTool()` member call on a non-SDK receiver (e.g. a bespoke `end.request('ping', undefined, id)` helper), corrupting the call.
