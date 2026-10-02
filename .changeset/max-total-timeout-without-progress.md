---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Enforce `RequestOptions.maxTotalTimeout` as a hard cap even when no progress notifications arrive. `_setupTimeout` previously armed only the per-request `timeout`, so a hung call with `{ timeout: 1000, maxTotalTimeout: 150 }` waited the full 1000ms and rejected with `Request timed out`. The pending timer now arms for whichever limit comes first, progress resets re-arm against the remaining budget, and expiry of the cap raises `Maximum total timeout exceeded`.
