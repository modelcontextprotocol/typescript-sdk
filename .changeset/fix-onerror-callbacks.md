---
'@modelcontextprotocol/server': patch
---

Fix transport errors being silently swallowed by adding missing `onerror` callback invocations before all `createJsonErrorResponse` calls in `WebStandardStreamableHTTPServerTransport`. This ensures errors like parse failures, invalid headers, and session validation errors are properly reported via the `onerror` callback.
