---
'@modelcontextprotocol/sdk': patch
---

Return JSON-RPC `-32600` (`Invalid Request`) instead of `-32700` (`Parse error`) when Streamable HTTP receives valid JSON that is not a valid JSON-RPC message (or an empty batch `[]`), and return JSON-RPC `-32700` (`Parse error: Invalid JSON`) from `createMcpExpressApp()` on
malformed JSON bodies instead of Express's default HTML error page.
