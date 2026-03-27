---
'@modelcontextprotocol/client': patch
---

Handle 404 and 406 responses gracefully in GET SSE stream initialization, matching existing 405 behavior. Servers that lack a GET handler (404) or reject `Accept: text/event-stream` (406) now fall back to POST-only communication instead of throwing a fatal error.
