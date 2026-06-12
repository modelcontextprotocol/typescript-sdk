---
'@modelcontextprotocol/core': patch
---

Fix `resetTimeoutOnProgress` so it works without an `onprogress` handler. Previously, a progress notification for an in-flight request that had no registered `onprogress` handler was treated as an unknown-token error and returned before the timeout was reset, so `resetTimeoutOnProgress: true` silently did nothing unless `onprogress` was also provided. The request timeout now resets on progress regardless of whether an `onprogress` handler is registered, and a notification is only reported as an unknown token when neither a progress handler nor an in-flight request is associated with it.
