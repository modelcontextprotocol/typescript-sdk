---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/express': patch
---

Add experimental Server Card extension support (SEP-2127) behind new
`experimental/server-card` subpaths. `@modelcontextprotocol/core` gains the
Zod schemas, inferred types, and wire constants for Server Cards and AI
Catalogs. `@modelcontextprotocol/server` gains `buildServerCard`,
`buildAICatalog`, `serverCardCatalogEntry`, `getServerCardUrl`, and the
web-standard `serverCardResponse`/`aiCatalogResponse` responders (CORS,
Cache-Control, strong ETag with If-None-Match 304s, sync fall-through
matching). `@modelcontextprotocol/client` gains hardened `fetchServerCard`,
`fetchAICatalog`, and `discoverServerCards` helpers (HTTPS-only defaults,
private-address and single-label host guards, size and redirect caps,
credential-free requests, caller-owned ETag caching, listing-chain
provenance), plus `requiredRemoteInputs`, `resolveRemote`,
`reconcileServerCard`, and `ServerCardError`. `@modelcontextprotocol/express`
gains a thin `mcpServerCardRouter` adapter over the neutral responders.
Nothing lands on any package root; the subpaths are the experimental marker
and may change or be removed in any release.
