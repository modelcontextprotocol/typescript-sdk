---
status: scaffold
shape: explanation
---

# Packages and subpath exports

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Which of the 10 packages, why subpaths exist
teaches: @modelcontextprotocol/server, /client, /core, /node, /express, /hono, /fastify,
         /server-legacy, /codemod, the ./stdio subpath rule
source: mined from README.md "Packages" + "Installation"; packages/*/README.md;
        the runtime-posture invariant (root entry web-standard, node-only code at ./stdio).
table-minimal (proposal §7): one short list, not a feature matrix; the package count (10,
incl. private core-internal) is re-verified at the GA freeze. Sits last in get-started, off
the corridor (crit 92 MF3).
-->

## Start from one package

<!-- teaches: @modelcontextprotocol/server root vs ./stdio subpath | salvage: README.md "Getting Started" imports -->

```ts
// draft - API verified against packages/server/src/index.ts and packages/server/src/stdio.ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
```

<!-- result: everything in the server tutorial came from this one package; the second import
     line is the only place a subpath appeared, and this page explains why. -->

## Pick the package for your side of the protocol

<!-- teaches: server vs client as the two installable starting points | salvage: README.md "Packages" + "Installation" -->
<!-- code: sh — `npm install @modelcontextprotocol/server` and `npm install @modelcontextprotocol/client`,
     the only two install commands most readers ever run -->

## Keep node-only code behind the ./stdio subpath

<!-- teaches: WHY subpath exports exist — the root entry of server and client is runtime-neutral
     (browser / Workers safe); anything that spawns processes or imports node: builtins lives at
     ./stdio. | salvage: packages/server/src/stdio.ts and packages/client/src/stdio.ts header
     comments; report-86 invariant. -->
<!-- code: ts — the failing counter-example as a comment: importing StdioClientTransport from the
     root entry is not possible by design; the bundler never sees node:child_process unless you
     import the subpath -->

## Add a framework adapter when you serve over HTTP

<!-- teaches: @modelcontextprotocol/node, /express, /hono, /fastify are optional thin adapters
     around createMcpHandler — install only the one matching your framework.
     salvage: README.md "Middleware packages (optional)" + "Optional middleware packages" install block. -->
<!-- code: sh — `npm install @modelcontextprotocol/express express` (one representative line;
     the four recipe pages under serving/ carry their own) -->

## Reach for core only to validate raw wire JSON

<!-- teaches: @modelcontextprotocol/core ships ONLY the Zod schema constants; server and client
     stay Zod-free on their public surface. Gateways and proxies are its audience.
     salvage: packages/core/README.md opening paragraphs. -->
<!-- code: ts — CallToolResultSchema.safeParse(json) as the one canonical use -->

## Leave server-legacy and codemod to the migration guide

<!-- teaches: @modelcontextprotocol/server-legacy (v1-era SSE transport + OAuth Authorization
     Server) and @modelcontextprotocol/codemod (the v1 -> v2 CLI) exist to be linked, not taught.
     salvage: docs/faq.md "Why did we remove server SSE transport?" + "Where are the server auth
     helpers?"; link target is /migration/upgrade-to-v2. -->
<!-- code: none — two sentences and a link. -->

## Recap

<!-- the 5 claims this page will prove:
- Two packages cover almost everyone: server to build servers, client to build clients.
- Package roots are runtime-neutral; node-only code (process spawning, stdio) lives at ./stdio.
- The framework adapters (node, express, hono, fastify) are optional and thin; pick one.
- core exists only for raw Zod schema validation of wire JSON.
- server-legacy and codemod are migration surfaces, reached from the migration guide.
-->
