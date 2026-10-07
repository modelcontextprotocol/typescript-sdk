---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Progress notifications that arrive before their request's response are now delivered to `onprogress` even when both land in the same transport read (for example one stdio chunk). Notification handlers run on a microtask while responses are handled synchronously, so the response used to remove the progress handler before the queued notifications ran, dropping them and reporting "unknown token" errors. Progress that arrives after the response is still discarded.
