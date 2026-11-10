---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Progress notifications that arrive in the same transport read as their request's response are now delivered to the `onprogress` callback before the response settles the request. Previously the notification handler ran in a microtask after the response had already removed the progress handler, so those updates were silently dropped. Only `notifications/progress` is dispatched synchronously; other notifications keep microtask dispatch.
