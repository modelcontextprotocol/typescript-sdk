---
'@modelcontextprotocol/sdk': patch
---

Preserve a user-declared `listChanged: false` in the `McpServer` constructor options for `tools`, `resources` and `prompts`. Previously each was unconditionally advertised as `listChanged: true` once its request handlers were registered, overriding the declared value.
