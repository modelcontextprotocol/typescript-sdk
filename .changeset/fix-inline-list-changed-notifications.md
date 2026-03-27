---
'@modelcontextprotocol/server': patch
---

Allow `sendToolListChanged`, `sendResourceListChanged`, and `sendPromptListChanged` to forward notification options such as `relatedRequestId`. This lets streamable HTTP servers deliver those notifications inline on the active POST SSE response instead of silently dropping them
when no standalone GET SSE channel is open.
