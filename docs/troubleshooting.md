---
status: scaffold
shape: reference
---
# Troubleshooting

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Verbatim error message as each heading; seeded from faq.md; pruning rule stated.
teaches: serveStdio, console.error-on-stdio, zod dedupe, globalThis.crypto, SdkError(EraNegotiationFailed), SdkError(MethodNotSupportedByProtocolVersion), @modelcontextprotocol/server-legacy
source: mined from docs/faq.md (all four entries), docs/server-quickstart.md "IMPORTANT" stdio box, docs/migration/support-2026-07-28.md "Client side: versionNegotiation"
FORMAT RULE (reference page): every H2 below is the VERBATIM error message a reader
pastes into search — not an imperative micro-step. Entries are ordered by how often
they hit, not by topic.
-->

::: info
<!-- PRUNING RULE (stated on-page, proposal §5): an entry lives only as long as the
surface that produces it. Entries tied to a removed era, package, or Node version are
deleted with it — this page never accretes. -->
:::

## `SyntaxError: Unexpected token ... is not valid JSON`
<!-- teaches: stdout is the wire on stdio; log to stderr | salvage: docs/server-quickstart.md "IMPORTANT" box (the #1 real-world stdio bug, agent-report 89 §7) -->
On stdio, standard output carries JSON-RPC. One `console.log` corrupts the stream; log to `stderr`.

```ts
// draft - API verified against packages/server/src/server/serveStdio.ts (serveStdio L375) and packages/server/src/stdio.ts (subpath export)
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
  const server = new McpServer({ name: 'app', version: '1.0.0' });
  console.error('app server running on stdio'); // stderr — never console.log on stdio
  return server;
});
```
<!-- result: the client parses every stdout line as JSON-RPC; the stderr line shows up in the host's log, not on the wire -->

## `TS2589: Type instantiation is excessively deep and possibly infinite`
<!-- teaches: single zod version in the tree | salvage: docs/faq.md "Why do I see TS2589 ... after upgrading the SDK?" -->
<!-- code: sh block — npm ls zod / pnpm why zod, then the overrides/resolutions fix -->

## `ReferenceError: crypto is not defined`
<!-- teaches: globalThis.crypto polyfill for the OAuth client helpers on Node 18 | salvage: docs/faq.md "How do I enable Web Crypto ..." -->
<!-- code: ts block — node:crypto webcrypto polyfill assignment, mirroring packages/client/vitest.setup.js -->

## `SdkError: ERA_NEGOTIATION_FAILED`
<!-- teaches: connect() rejects when the mode/supported-versions list leaves no era both sides speak | salvage: docs/migration/support-2026-07-28.md "Client side: versionNegotiation" -->
<!-- code: the failing shape (mode: { pin: '2026-07-28' } against a 2025-only server) and the two fixes (mode: 'auto', or add a 2025 entry to supportedProtocolVersions) -->
<!-- era caveat: ONE line linking /protocol-versions for what an era is -->

## `SdkError: METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`
<!-- teaches: an outbound spec method that the negotiated era does not define | salvage: docs/migration/support-2026-07-28.md "Appendix" behavior matrix row -->
<!-- code: the failing call and the matrix-backed replacement; one line linking /protocol-versions -->

## `Module '"@modelcontextprotocol/server"' has no exported member 'SSEServerTransport'`
<!-- teaches: where server SSE and the AS auth helpers went (@modelcontextprotocol/server-legacy) | salvage: docs/faq.md "Why did we remove server SSE transport?" + "Where are the server auth helpers?" -->
<!-- code: the import rewrite — server SSE from @modelcontextprotocol/server-legacy/sse, AS helpers from @modelcontextprotocol/server-legacy/auth; RS helpers are first-class in @modelcontextprotocol/express -->

## Recap
<!-- the claims this page will prove:
- Every heading is the exact message you searched for.
- On stdio, stdout is the protocol; log with console.error.
- TS2589 means two zod copies in the tree.
- ERA_NEGOTIATION_FAILED and METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION are negotiation outcomes, explained once on the protocol-versions page.
- Server SSE and the AS helpers live in @modelcontextprotocol/server-legacy.
- Entries die with the surface that produced them.
-->
