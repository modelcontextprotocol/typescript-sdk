---
'@modelcontextprotocol/server': patch
---

A tool that throws `MissingRequiredClientCapabilityError` now answers `tools/call` with JSON-RPC error `-32021` and its `requiredCapabilities`, as the spec requires, instead of an `isError` tool result. This changes what such a tool returns for every `McpServer`: a client that read the message from the tool result now gets a `ProtocolError` with code `-32021`. Over HTTP on 2026-07-28 the response status is 400, unless the response stream is already open. The same applies to a `-32021` a tool relays from a downstream server: catch and translate it instead of rethrowing, because its `requiredCapabilities` describe the downstream hop.
