---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `Client.extension()` / `Server.extension()` registrar for SEP-2133 capability-aware custom methods. Declares an extension in `capabilities.extensions[id]` and returns an `ExtensionHandle` whose `setRequestHandler`/`sendRequest`/`setNotificationHandler`/`sendNotification` calls are tied to that declared capability. `getPeerSettings()` returns the peer's extension settings, optionally validated against a `peerSchema`.
