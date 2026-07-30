---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

`createMcpHandler` now rejects a modern-era POST that omits the required
`MCP-Protocol-Version` header. The 2026-07-28 Streamable HTTP specification
requires the header on every POST, but the standard-header rung only checked
`Mcp-Method` / `Mcp-Name` presence and the classifier only cross-checked the
protocol-version header when it was present — so a request carrying a valid
`_meta` envelope but no version header dispatched and answered HTTP 200.

`validateStandardRequestHeaders` now emits the same `HeaderMismatch`
(`-32020`) rejection on HTTP 400 for the absent header as it already does for
an absent `Mcp-Method`, on the `standard-header-validation` rung, echoing the
request id. The entry passes the header through for that check. Scope is
unchanged everywhere else: the presence rung only runs on a modern-classified
request, so notifications, legacy-era POSTs, and body-less `GET`/`DELETE`
session operations behave exactly as before, and a present-but-disagreeing
header is still answered by the classifier's edge `header-body-version-mismatch`
cell.
