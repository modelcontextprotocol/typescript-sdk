---
'@modelcontextprotocol/client': patch
---

`PrivateKeyJwtProvider` and `createPrivateKeyJwtAuth()` now sign with an Ed25519 key given as a PEM string when the algorithm is `EdDSA` or `Ed25519`. They threw `Unsupported algorithm EdDSA` before, although the same key given as a `Uint8Array` or a JWK already worked.
