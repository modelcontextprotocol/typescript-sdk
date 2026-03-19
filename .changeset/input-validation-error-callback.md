---
'@modelcontextprotocol/server': minor
---

Add `onInputValidationError` callback to `McpServerOptions`. When a tool call fails input schema validation, this callback fires before the error is returned to the client, enabling observability (logging, metrics) for invalid tool calls.
