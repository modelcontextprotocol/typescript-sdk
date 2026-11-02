# Production catalog fixture 211240

Catalogue-derived fixture for the cold `Client.callTool` regression. It is the frozen public tool catalog, not the REA product.

## Source

- Repository: `morluto/rea`
- Commit: `21650455a9c90a26e725c3505a3c17054cc4516c`
- License: MIT, retained in `LICENSE.MIT.txt`
- Generator: `scripts/generate-mcp-tool-catalog.mjs` registers `TOOL_CONTRACTS` on `McpServer` and reads `listTools`
- Captured by the 211238 extractor from that public registration path, without installing the REA app
- Predecessor export: `a9ca707da97e4613c8c40bbd3d158b59ddf86cde`

`tools.json.gz` is the gzip of that canonical wire array. `identity.json` locks the raw, document, and gzip sha256 values. Normal tests gunzip the file and check those bytes. They do not fetch or rebuild the catalog.

The array has 170 tools and 340 input/output schemas. The invoked tool is `binary_session` with input `{}`. Its structured content is a benign closed session, `open: false`. No binary was analyzed. The schema bytes are the unmodified public catalog. The session body is synthetic fixture data.

## What the regression checks

A real `Client` talks to this fixture over the in-memory transport, and once over stdio loopback. The cold call compiles only `binary_session`. The benign body is accepted. Malformed structured content is refused, then a valid call recovers on the memoized validator. A same-tool schema change plus `notifications/tools/list_changed` drops that validator. The previous body is refused and the recovery body is accepted. The other 169 output schemas stay uncompiled.

`pnpm run bench:production-catalog` is the optional cold-process benchmark. It is not part of `pnpm test`. It reports this machine's timings and does not set a universal millisecond threshold.
