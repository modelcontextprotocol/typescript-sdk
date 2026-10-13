---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Validate Streamable HTTP `Accept` values by parsed media type and positive quality instead of substring matching, so invalid tokens such as `application/jsonx`, `text/event-stream-bogus`, and required types with `q=0` no longer satisfy the response requirements.
