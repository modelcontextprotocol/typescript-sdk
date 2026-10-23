---
'@modelcontextprotocol/sdk': patch
---

Validate Streamable HTTP `Accept` values by parsed media type and positive quality instead of substring matching. Invalid tokens such as `application/jsonx` and `text/event-stream-bogus`, plus required types with `q=0`, no longer satisfy the response requirements.
