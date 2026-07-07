---
'@modelcontextprotocol/client': patch
---

Version negotiation no longer discards transport handlers the caller set before `connect()`. The probe window now saves any pre-set `onmessage`/`onerror`/`onclose`, forwards error and close events to them while the probe is in flight, and restores them when the window closes — so `Protocol.connect()` chains them exactly as it does on a plain connect. Previously, connecting with `versionNegotiation` silently cleared pre-set handlers (e.g. an `onerror` used to detect session-expiry auth failures), leaving them permanently detached for the life of the connection.
