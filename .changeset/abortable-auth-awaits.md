---
'@modelcontextprotocol/client': patch
---

Make the streamable HTTP transport's auth awaits abortable. `AuthProvider.token()`, `onUnauthorized()` 401 recovery, and insufficient-scope step-up authorization were awaited with no way for `TransportSendOptions.requestSignal` (or the transport's own lifetime signal) to reach them, so a hung token refresh or recovery flow parked `send()` forever past its abort. These awaits are now raced against the combined request/transport signal, and the signal is offered to `onUnauthorized` via the new optional `UnauthorizedContext.signal` field so cooperative providers can cancel their own recovery work. An abort during the auth chain rejects the send with the abort reason (unstamped, treated as an intentional teardown, no spurious `onerror`).
