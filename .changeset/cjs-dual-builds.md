---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server-legacy': minor
'@modelcontextprotocol/codemod': minor
'@modelcontextprotocol/express': minor
'@modelcontextprotocol/hono': minor
'@modelcontextprotocol/fastify': minor
'@modelcontextprotocol/node': minor
---

Ship CommonJS builds alongside ESM for all v2 packages, so `require()` consumers and CJS-only toolchains can use the SDK without a bundler shim.
