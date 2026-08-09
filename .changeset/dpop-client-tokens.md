---
"@modelcontextprotocol/client": minor
---

Add DPoP (RFC 9449 / SEP-1932) sender-constrained token support. Hosts opt in by implementing `OAuthClientProvider.dpop()`; when present, the client presents `Authorization: DPoP <token>` plus a per-request proof (via `authorizeRequest`/`consumeChallenge` on `AuthProvider`) instead of a plain Bearer token, on both the Streamable HTTP and SSE transports, and handles authorization-server and resource-server nonce challenges.
