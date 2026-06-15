---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Mark the roots, sampling, and logging runtime APIs as `@deprecated` per SEP-2577 (deprecated as of protocol version 2026-07-28; functional for at least twelve months). Annotates `Server.createMessage`/`listRoots`/`sendLoggingMessage`, `McpServer.sendLoggingMessage`, `Client.setLoggingLevel`/`sendRootsListChanged`, the `ServerContext.mcpReq.log`/`requestSampling` helpers, and the `roots`/`sampling`/`logging` capability schema fields. JSDoc/docs only — no behavior change.
