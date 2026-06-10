---
'@modelcontextprotocol/test-conformance': patch
---

Fix the server conformance script leaking the test server process: the cleanup trap killed the npx wrapper while the actual server kept listening on port 3000, making later runs silently test stale code or hang forever in the readiness loop. The script now spawns the server directly with `node --import tsx`, refuses to start while the port is taken, and bounds each readiness probe; both test servers report `EADDRINUSE` with an actionable message, and the plain `test:conformance:client` script works again (`--suite core`, required since conformance 0.2.0-alpha.1).
