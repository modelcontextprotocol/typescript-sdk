---
'@modelcontextprotocol/codemod': patch
---

v1-to-v2: now wraps `outputSchema` raw shapes with `z.object()`; importMap covers `sdk/server/express.js`, `sdk/server/middleware/hostHeaderValidation.js`, and `sdk/client/auth-extensions.js`. The unreachable `expressMiddleware` transform is removed.
