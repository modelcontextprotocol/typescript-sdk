---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Validate Streamable HTTP `Accept` values by parsed media type instead of substring matching, so invalid tokens such as `application/jsonx` and `text/event-stream-bogus` no longer satisfy the required response types.
