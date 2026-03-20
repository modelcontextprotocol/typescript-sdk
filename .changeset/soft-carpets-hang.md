---
"@modelcontextprotocol/server": patch
---

fix(server): invoke onerror callback for all error responses

Previously, several error responses in StreamableHTTPServerTransport were returned without invoking the onerror callback, making it impossible to debug or log these errors.

This change ensures all error responses call this.onerror() before returning, matching the existing pattern in validateRequestHeaders().
