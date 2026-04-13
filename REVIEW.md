# typescript-sdk Review Conventions

Guidance for reviewing pull requests on this repository. The first three sections are
stable principles; the **Recurring Catches** section is auto-maintained from past human
review rounds and grows over time.

## Guiding Principles

1. **Minimalism** — The SDK should do less, not more. Protocol correctness, transport
   lifecycle, types, and clean handler context belong in the SDK. Middleware engines,
   registry managers, builder patterns, and content helpers belong in userland.
2. **Burden of proof is on addition** — The default answer to "should we add this?" is
   no. Removing something from the public API is far harder than not adding it.
3. **Justify with concrete evidence** — Every new abstraction needs a concrete consumer
   today. Ask for real issues, benchmarks, real-world examples; apply the same standard
   to your own review (link spec sections, link code, show the simpler alternative).
4. **Spec is the anchor** — The SDK implements the protocol spec. The further a feature
   drifts from the spec, the stronger the justification needs to be.
5. **Kill at the highest level** — If the design is wrong, don't review the
   implementation. Lead with the highest-level concern; specific bugs are supporting
   detail.
6. **Decompose by default** — A PR doing multiple things should be multiple PRs unless
   there's a strong reason to bundle.

## Review Ordering

1. **Design justification** — Is the overall approach sound? Is the complexity warranted?
2. **Structural concerns** — Is the architecture right? Are abstractions justified?
3. **Correctness** — Bugs, regressions, missing functionality.
4. **Style and naming** — Nits, conventions, documentation.

## Checklist

**Protocol & spec**
- Types match [`schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/draft/schema.ts) exactly (optional vs required fields)
- Correct `ProtocolError` codes (enum `ProtocolErrorCode`); HTTP status codes match spec (e.g., 404 vs 410)
- Works for both stdio and Streamable HTTP transports — no transport-specific assumptions
- Cross-SDK consistency: check what `python-sdk` does for the same feature

**API surface**
- Every new export is intentional (see CLAUDE.md § Public API Exports); helpers users can write themselves belong in a cookbook, not the SDK
- New abstractions have at least one concrete callsite in the PR
- One way to do things — improving an existing API beats adding a parallel one

**Correctness**
- Async: race conditions, cleanup on cancellation, unhandled rejections, missing `await`
- Error propagation: caught/rethrown properly, resources cleaned up on error paths
- Type safety: no unjustified `any`, no unsafe `as` assertions
- Backwards compat: public-interface changes, default changes, removed exports — flagged and justified

**Tests & docs**
- New behavior has vitest coverage including error paths
- Breaking changes documented in `docs/migration.md` and `docs/migration-SKILL.md`
- Bugfix or behavior change: check whether `docs/**/*.md` describes the old behavior and needs updating; flag prose that now contradicts the implementation
- New feature: verify prose documentation is added (not just JSDoc), and assess whether `examples/` needs a new or updated example
- Behavior change: assess whether existing `examples/` still compile and demonstrate the current API

## Reference

When verifying spec compliance, consult the spec directly rather than relying on memory:

- MCP documentation server: `https://modelcontextprotocol.io/mcp`
- Full spec text (single file, LLM-friendly): `https://modelcontextprotocol.io/llms-full.txt` — fetch to a temp file and grep for the relevant section
- Schema source of truth: [`schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/draft/schema.ts)

## Recurring Catches

### HTTP Transport

- When validating `Mcp-Session-Id`, return **400** for a missing header and **404** for an unknown/expired session — never conflate `!sessionId || !transports[sessionId]` into one status, because the client needs to distinguish "fix your request" from "start a new session". Flag any diff that branches on session-id presence/lookup with a single 4xx. (#1707, #1770)

### Error Handling

- Broad `catch` blocks must not emit client-fault JSON-RPC codes (`-32700` ParseError, `-32602` InvalidParams) for server-internal failures like stream setup, task-store misses, or polling errors — map those to `-32603` InternalError so clients don't retry/reformat pointlessly. Flag any catch-all that hard-codes ParseError/InvalidParams without discriminating the thrown cause. (#1752, #1769)

### Schema Compliance

- When editing Zod protocol schemas in `schemas.ts`, verify unknown-key handling matches the spec `schema.ts`: if the spec type has no `additionalProperties: false`, the SDK schema must use `z.looseObject()` / `.catchall(z.unknown())` rather than implicit strict — over-strict Zod (incl. `z.literal('object')` on `type`) rejects spec-valid payloads from other SDKs. Also confirm `spec.types.test.ts` still passes bidirectionally. (#1768, #1849, #1169)

### Async / Lifecycle

- In `close()` / shutdown paths, wrap user-supplied or chained callbacks (`onclose?.()`, cancel fns) in `try/finally` so a throw can't skip the remaining teardown (`abort()`, `_onclose()`, map clears) — otherwise the transport is left half-open. (#1735, #1763)
- Deferred callbacks (`setTimeout`, `.finally()`, reconnect closures) must check closed/aborted state before mutating `this._*` or starting I/O — a callback scheduled pre-close can fire after close/reconnect and corrupt the new connection's state (e.g., delete the new request's `AbortController`). (#1735, #1763)

### Completeness

- When a PR replaces a pattern (error class, auth-flow step, catch shape), grep the package for surviving instances of the old form — partial migrations leave sibling code paths with the very bug the PR claims to fix. Flag every leftover site. (#1657, #1761, #1595)

### Documentation & Changesets

- Read added `.changeset/*.md` text and new inline comments against the implementation in the same diff — prose that promises behavior the code no longer ships misleads consumers and contradicts stated intent. Flag any claim the diff doesn't back. (#1718, #1838)

### CI & GitHub Actions

- Do **not** assert that a third-party GitHub Action or publish toolchain will fail or needs extra permissions/tokens without verifying its docs or source — `pnpm publish` delegates to the system npm CLI (so npm OIDC works), and `changesets/action` in publish mode has no PR-comment step requiring `pull-requests: write`. For diffs under `.github/workflows/`, confirm claimed behavior in the action's README/source before flagging. (#1838, #1836)
