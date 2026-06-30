---
status: scaffold
shape: how-to
---
# Serve over stdio

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: serveStdio and the console.error gotcha.
teaches: serveStdio, StdioServerHandle, console.error-vs-console.log, handle.close
source: mined from docs/server.md "stdio" + "Serving the 2026-07-28 draft revision on stdio" + "Shutdown"; docs/server-quickstart.md "Running your server" (the console.error IMPORTANT box)
era/legacy note: the legacy: posture is owned by serving/legacy-clients.md (proposal §1); this page carries one aside that links it.
-->

## Serve a factory over stdio
<!-- teaches: serveStdio | salvage: docs/server.md "Serving the 2026-07-28 draft revision on stdio" -->

```ts
// draft - API verified against packages/server/src/server/serveStdio.ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...) — the same factory serves every era a client opens with
  return server;
});
```
<!-- result: one line — the process is an MCP server on stdin/stdout; a host that spawns it can call its tools -->
<!-- aside (::: info Coming from v1?): serveStdio replaces the StdioServerTransport + connect() wiring — run the codemod, then see /migration/upgrade-to-v2. -->
<!-- aside (::: info): older clients are served from the same factory by default; the `legacy:` option and the
     full story live on /serving/legacy-clients. Era detail is one line linking /protocol-versions. -->

## Log to stderr, never stdout
<!-- teaches: the console.error gotcha | salvage: docs/server-quickstart.md "Running your server" IMPORTANT box (the #1 real-world stdio bug) -->
<!-- code: console.error('server ready') vs console.log — stdout is the JSON-RPC channel; one console.log corrupts it -->
<!-- result: the verbatim parse-error a host shows when a server writes to stdout -->

## Test it with the Inspector
<!-- teaches: npx @modelcontextprotocol/inspector | salvage: docs/server-quickstart.md "Testing your server" -->
<!-- code: sh placeholder — npx @modelcontextprotocol/inspector node ./build/server.js -->

## Shut down cleanly
<!-- teaches: StdioServerHandle.close(); SIGINT | salvage: docs/server.md "Shutdown" (stdio half) -->
<!-- code: process.on('SIGINT', () => handle.close()) -->

## Recap
<!-- the claims this page proves:
- serveStdio(factory) is the stdio entry point; it owns the transport and builds the instance that serves the connection.
- stdout is the protocol channel; log with console.error.
- The Inspector exercises a stdio server without a host.
- handle.close() tears down the pinned instance and the transport.
-->
