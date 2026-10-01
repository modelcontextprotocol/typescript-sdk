---
'@modelcontextprotocol/sdk': patch
---

Return tool input validation failures as Tool Execution Errors (a `CallToolResult` with `isError: true`) instead of throwing JSON-RPC `InvalidParams` protocol errors. Aligns `McpServer` with [SEP-1303](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1303)
(spec 2025-11-25), so the model can see the validation message and self-correct on retry. Closes #1956.
