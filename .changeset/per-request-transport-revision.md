---
'@modelcontextprotocol/server': patch
---

Connecting a `Server` or `McpServer` to a `PerRequestHTTPServerTransport` classified at a modern revision that `supportedProtocolVersions` lists and the SDK implements now binds that revision, instead of answering `-32022`.
