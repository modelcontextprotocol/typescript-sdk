---
'@modelcontextprotocol/sdk': patch
---

Read `resource_metadata` and `scope` from the `WWW-Authenticate` header when the Streamable HTTP client's GET SSE request gets a 401, before starting authorization. Previously only the POST path did this, so when the first 401 came from the GET path (`resumeStream()`, `send()`
with a `resumptionToken`, the standalone stream opened after `notifications/initialized`, SSE reconnects), discovery ran without the advertised metadata URL and could fall back to the MCP server's origin as the authorization server. Matches `SSEClientTransport` and the v2 change
in #1710. Fixes #1450.
