---
"@modelcontextprotocol/client": patch
---

Make StreamableHTTPClientTransport retry standalone SSE streams longer and fail fast after reconnection exhaustion instead of allowing later request responses to disappear behind a dead SSE channel. SSE open failures now include a fallback HTTP status when statusText is empty.
