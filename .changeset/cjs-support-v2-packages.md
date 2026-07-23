---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server-legacy': patch
'@modelcontextprotocol/codemod': patch
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/hono': patch
'@modelcontextprotocol/fastify': patch
'@modelcontextprotocol/node': patch
---

Ship CommonJS builds alongside ESM. Each package now emits both `.mjs`/`.d.mts`
and `.cjs`/`.d.cts` (via tsdown `format: ['esm', 'cjs']`), and its `exports` map
adds a `require` condition so `require('@modelcontextprotocol/…')` works from
CommonJS consumers. Output extensions are normalized across all packages
(`@modelcontextprotocol/core` moves from `.js`/`.d.ts` to `.mjs`/`.d.mts`); the
public import paths are unchanged.
