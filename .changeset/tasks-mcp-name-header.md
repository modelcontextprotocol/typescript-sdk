---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

Emit and validate the `Mcp-Name` header for tasks requests per SEP-2663's Streamable HTTP binding: the client transport now mirrors `params.taskId` into `Mcp-Name` on `tasks/get` / `tasks/update` / `tasks/cancel` (previously omitted, causing conforming servers to reject every task poll with `-32020 HeaderMismatch`), and the server-side standard-header validation cross-checks it via the same shared `MCP_NAME_HEADER_SOURCE` table.
