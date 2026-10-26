---
'@modelcontextprotocol/sdk': patch
---

Preserve a user-declared `listChanged: false` in the `McpServer` constructor options for `tools`, `resources` and `prompts`. Previously each was unconditionally advertised as `listChanged: true` once its request handlers were registered, overriding the declared value.
Additionally, `McpServer.sendToolListChanged()`, `sendResourceListChanged()` and `sendPromptListChanged()` are now gated on the declared value, so a server that advertised `listChanged: false` no longer emits the corresponding `notifications/*/list_changed` messages on the wire.
