---
'@modelcontextprotocol/node': patch
---

Prevent Hono from overriding global Response object by passing `overrideGlobalObjects: false` to `getRequestListener()`. This fixes compatibility with frameworks like Next.js whose response classes extend the native Response.
