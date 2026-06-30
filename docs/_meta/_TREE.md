# docs-v2 draft — full tree (45 pages)

This is the Phase 2 docs draft: 3 CALIBRATION pages (Felix-approved voice exemplars), 39 fully WRITTEN pages (prose complete, every `ts` fence backed by a typechecking companion in `examples/guides/`), and 3 VERBATIM-COPY migration files, on the approved 45-page structure.
Every WRITTEN page is reviewable as final prose: judge it against `_meta/CONVENTIONS.md` (REGISTER R1–R15) with the three CALIBRATION pages (`index.md`, `get-started/first-server.md`, `servers/tools.md`) as the voice baseline, and check structure against this file plus the page's H2 set.
Format: `path | shape | status | scope`. Sections appear in nav order. Status values: CALIBRATION (locked exemplar), WRITTEN (fully written this tranche), VERBATIM-COPY (byte-identical copy, untouched).

## Top level

| path | shape | status | scope |
| --- | --- | --- | --- |
| `index.md` | landing | CALIBRATION | What MCP is (3 sentences) · one server snippet · four doors |

## get-started/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `get-started/first-server.md` | tutorial | CALIBRATION | Setup once → one tool → run → see it answer |
| `get-started/real-host.md` | tutorial | WRITTEN | Plug your server into Claude Code / VS Code / Cursor |
| `get-started/first-client.md` | tutorial | WRITTEN | Connect, list, call, read, close — neutral, no vendor SDK |
| `get-started/packages.md` | explanation | WRITTEN | Which of the 10 packages, why subpaths exist |

## servers/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `servers/tools.md` | how-to | CALIBRATION | Register, the schema payoff, structured output |
| `servers/resources.md` | how-to | WRITTEN | Static + templated resources, list callbacks |
| `servers/prompts.md` | how-to | WRITTEN | Register prompts, message construction |
| `servers/completion.md` | how-to | WRITTEN | Autocomplete a schema field |
| `servers/logging-progress-cancellation.md` | how-to | WRITTEN | The ctx every handler receives: logging, progress, cancellation |
| `servers/elicitation.md` | how-to | WRITTEN | Ask the user (form mode, URL mode) |
| `servers/sampling.md` | how-to | WRITTEN | Ask the model — SUNSET-FRAMED (SEP-2577), banner at top, migration target first |
| `servers/input-required.md` | how-to | WRITTEN | Handle input_required (multi-round-trip requests) |
| `servers/notifications.md` | how-to | WRITTEN | Notify clients of changes |
| `servers/errors.md` | how-to | WRITTEN | isError vs McpError vs thrown; protocol error-code table at the bottom (allowed carve-out) |

## serving/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `serving/stdio.md` | how-to | WRITTEN | serveStdio and the console.error gotcha |
| `serving/http.md` | how-to | WRITTEN | createMcpHandler; the per-request factory model lives HERE (recipes link back) |
| `serving/express.md` | how-to | WRITTEN | Express recipe — self-contained, install one-liner at top, one back-link to http.md |
| `serving/hono.md` | how-to | WRITTEN | Hono recipe — same shape as express.md |
| `serving/fastify.md` | how-to | WRITTEN | Fastify recipe — same shape as express.md |
| `serving/web-standard.md` | how-to | WRITTEN | Web-standard runtimes (Workers etc.) recipe — same shape as express.md |
| `serving/sessions-state-scaling.md` | how-to | WRITTEN | Sessions, Resumability, Multi-node — stateless ruling first, two sentences |
| `serving/authorization.md` | how-to | WRITTEN | Bearer auth, PRM metadata, per-tool scopes. Opens with the one-line auth router |
| `serving/legacy-clients.md` | how-to | WRITTEN | The legacy: option; where SSE went |

## clients/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `clients/connect.md` | how-to | WRITTEN | Client + transports, what you can ask after connect |
| `clients/calling.md` | how-to | WRITTEN | The verbs; auto-aggregating pagination |
| `clients/server-requests.md` | how-to | WRITTEN | Sampling/elicitation handlers; era unification told once via one cross-link |
| `clients/roots.md` | how-to | WRITTEN | Provide roots — SUNSET-FRAMED (SEP-2577), banner at top |
| `clients/subscriptions.md` | how-to | WRITTEN | listen filters vs legacy subscribe |
| `clients/oauth.md` | how-to | WRITTEN | User-facing authorization-code flow. Opens with the one-line auth router |
| `clients/machine-auth.md` | how-to | WRITTEN | Client credentials, private-key JWT, cross-app access |
| `clients/middleware.md` | how-to | WRITTEN | Compose request/response middleware |
| `clients/caching.md` | how-to | WRITTEN | Client store + server cache hints, presented as one feature |

## Top level

| path | shape | status | scope |
| --- | --- | --- | --- |
| `protocol-versions.md` | explanation | WRITTEN | Eras — THE single quarantine page; the behavior matrix MOVES here from the support guide |

## advanced/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `advanced/low-level-server.md` | explanation | WRITTEN | Rebuild the Tools example by hand on Server; McpServer-vs-Server decision criteria |
| `advanced/custom-methods.md` | how-to | WRITTEN | Vendor-prefixed methods, extension capabilities |
| `advanced/schema-libraries.md` | how-to | WRITTEN | Valibot/ArkType, JSON-Schema-in, pluggable validators |
| `advanced/custom-transports.md` | how-to | WRITTEN | Implement the Transport interface |
| `advanced/wire-schemas.md` | how-to | WRITTEN | @modelcontextprotocol/core for gateways/proxies (raw wire schemas) |
| `advanced/gateway.md` | how-to | WRITTEN | Zero-round-trip reconnect with a prior discover result |

## Top level

| path | shape | status | scope |
| --- | --- | --- | --- |
| `testing.md` | how-to | WRITTEN | In-memory linked pair + handler.fetch — no sockets |
| `troubleshooting.md` | reference | WRITTEN | Verbatim error message as each heading; seeded from faq.md; pruning rule stated |

## migration/

| path | shape | status | scope |
| --- | --- | --- | --- |
| `migration/index.md` | reference | VERBATIM-COPY | Byte-identical copy of `docs/migration/index.md` — untouched per the approved tree |
| `migration/upgrade-to-v2.md` | reference | VERBATIM-COPY | Byte-identical copy of `docs/migration/upgrade-to-v2.md` — untouched per the approved tree |
| `migration/support-2026-07-28.md` | reference | VERBATIM-COPY | Byte-identical copy of `docs/migration/support-2026-07-28.md` — untouched per the approved tree |
