---
'@modelcontextprotocol/codemod': patch
---

Backlog fixes. When the zod import injection fires in a package that declares no zod, the manifest pass adds it (devDependencies when only tests import it) so strict node_modules layouts install cleanly. The ErrorCode-split pairing re-points stale `as ProtocolError`/`as McpError` casts bound to subjects whose assertions it moves to `SdkError`. Handler registration resolves one same-file variable hop (`const S = ListToolsRequestSchema`) before declaring a schema custom. Shorthand and aliased destructures of SDK dynamic imports rename with the static-import pass. Call-shape assertions pinning a registration schema (`expect.objectContaining({ inputSchema: … })`) get an advisory. The guide covers dist-text pins (no CJS-resolvable subpaths, content-hashed chunks, changed quote style, ESM-only output).
