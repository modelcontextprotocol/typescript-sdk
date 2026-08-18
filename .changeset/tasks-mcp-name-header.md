---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Emit and validate the `Mcp-Name` header for tasks requests per SEP-2663's Streamable HTTP binding: the client transport now mirrors `params.taskId` into `Mcp-Name` on `tasks/get` / `tasks/update` / `tasks/cancel` (previously omitted, causing conforming servers to reject every task poll with `-32020 HeaderMismatch`), and the server-side standard-header validation cross-checks it via the same shared `MCP_NAME_HEADER_SOURCE` table.

On the server, `createMcpHandler` now answers a modern (2026-07-28) `tasks/get` / `tasks/update` / `tasks/cancel` POST that omits `Mcp-Name`, or whose header disagrees with `params.taskId`, with `400` / `-32020` (`HeaderMismatch`) at the `standard-header-validation` rung, the same treatment `tools/call` / `prompts/get` / `resources/read` already get. Legacy-era (2025-11-25) tasks traffic is unaffected. Clients built with this SDK release send the header; hand-rolled clients that omitted it must add it.
