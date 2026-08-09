---
"@modelcontextprotocol/server": minor
"@modelcontextprotocol/express": minor
---

Add DPoP (RFC 9449 / SEP-1932) proof validation for resource servers. New `requireDpopAuth` gate (`@modelcontextprotocol/express`, backed by `verifyDpopProof`/`verifyDpopToken` in `@modelcontextprotocol/server`) validates DPoP proofs and access-token binding (`cnf.jkt`) by hand-rolled WebCrypto — no new runtime dependency. `verifyBearerToken` now rejects a DPoP-bound token presented under the `Bearer` scheme, per RFC 9449 §7.1.
