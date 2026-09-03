---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Spec-method requests whose params fail the method's wire schema are now answered with `-32602` Invalid params instead of `-32603` Internal error. Per JSON-RPC 2.0, invalid method parameters are the caller's error — the previous surface told callers the server broke rather than that their params were wrong (e.g. `logging/setLevel` with `{ level: 'not-a-level' }`).

This is a wire-visible behavior change: peers that matched on `-32603` for schema-invalid spec-method params will now observe `-32602`. Custom handlers registered with a params schema already answered `-32602`; spec methods now match that surface. The dispatch-rejection corpus fixture pinning this outcome is updated in the same change.
