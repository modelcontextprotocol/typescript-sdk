---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add an experimental `instrumentation` option to `Client`, `Server` and `McpServer` for tracing and metrics. The SDK calls its `send` hook for every request and notification it sends and its `receive` hook for every one it receives, and ends the returned scope once with how the message settled. Trace-context keys the hook writes go into `params._meta`, and the handler or transport send runs inside the scope. Leaving the option out changes nothing on the wire, and a hook that throws never fails the operation.
