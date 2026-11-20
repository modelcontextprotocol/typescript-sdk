---
'@modelcontextprotocol/client': patch
---

`callTool()` with `allowInputRequired: true` now returns an `input_required` result for a tool that declares an `outputSchema`, instead of throwing because the result has no `structuredContent`. Output-schema validation still applies to the completed result of the retry.
