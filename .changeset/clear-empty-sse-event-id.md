---
'@modelcontextprotocol/client': patch
---

Clear the Streamable HTTP client's resumption token when an SSE event explicitly supplies an empty `id` field. Notify `onresumptiontoken` with the empty string and omit `Last-Event-ID` on subsequent GET reconnects, while preserving the previous token when the ID field is absent. An empty ID also clears POST-stream resumability so a request is not resumed without a usable token.
