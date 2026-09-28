---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Sending a notification on a closed connection no longer produces a briefly unhandled promise rejection (seen as `unhandledrejection` on Cloudflare Workers) in addition to the returned rejection.
