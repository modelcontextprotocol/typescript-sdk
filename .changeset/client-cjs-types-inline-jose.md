---
'@modelcontextprotocol/client': patch
---

Fix a type-check failure for CommonJS TypeScript projects introduced in 2.1.0: `dist/index.d.cts` imported types from `jose`, which is ESM-only, so `tsc` with `module: node16`/`node18` and `skipLibCheck: false` failed with TS1479. The two `jose` types used by the DPoP API (`CryptoKey`, `JWK`) are now inlined into the declaration files. No runtime change.
