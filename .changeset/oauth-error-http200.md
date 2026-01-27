---
'@modelcontextprotocol/client': patch
---

Fix OAuth error handling for servers returning errors with HTTP 200 status

Some OAuth servers (e.g., GitHub) return error responses with HTTP 200 status instead of 4xx. The SDK now checks for an `error` field in the JSON response before attempting to parse it as tokens, providing users with meaningful error messages.
