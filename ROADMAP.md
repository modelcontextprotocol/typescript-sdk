# Roadmap

## Spec Implementation Tracking

The SDK tracks implementation of MCP spec components via GitHub Projects, with a dedicated project board for each spec revision:

- [2026-07-28 spec revision board](https://github.com/orgs/modelcontextprotocol/projects/41) — implemented in v2.0.0 (released 2026-07-27, alongside the spec).
- [2025-11-25 spec revision board](https://github.com/orgs/modelcontextprotocol/projects/26) — implemented in v1.23.0 (2025-11-25) and carried into v2, minus the experimental tasks component (SEP-1686), which v2 does not serve.

Conformance against the 2025-11-25 and 2026-07-28 revisions runs on each push to `main` (and against 2025-11-25 on `v1.x`) via the [conformance workflow](https://github.com/modelcontextprotocol/typescript-sdk/actions/workflows/conformance.yml) using the [MCP conformance suite](https://github.com/modelcontextprotocol/conformance).

## Current Focus Areas

### v2 hardening

v2.0.0 is the stable release line (`main`). Post-release work is tracked as issues on this repository and released as 2.x patch and minor releases (see `VERSIONING.md`):

- Migration tooling and guides (`@modelcontextprotocol/codemod`, `docs/migration/`).
- Runtime coverage beyond Node.js (Bun, Deno, Cloudflare Workers, Vercel) and the framework integrations (`node`, `express`, `hono`, `fastify`).
- Documentation completeness for every non-experimental spec feature at https://ts.sdk.modelcontextprotocol.io/v2/.

### Next Spec Revision

The next MCP specification revision is being developed in the [protocol repository](https://github.com/modelcontextprotocol/modelcontextprotocol). The SDK implements accepted SEPs as they are finalized so that support ships with the spec release, with a dedicated project board tracking component-level progress for that revision.

### Extensions

Protocol extensions are implemented as they stabilize and are not part of the core tier requirements:

- Tasks (`io.modelcontextprotocol/tasks`) — [#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189).
- Client authentication extensions: Workload Identity Federation (SEP-1933) — [#2576](https://github.com/modelcontextprotocol/typescript-sdk/issues/2576); DPoP (SEP-1932).

### v1.x Maintenance

The `v1.x` branch (`@modelcontextprotocol/sdk`) continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27). It targets the 2025-11-25 spec revision; new spec revisions are implemented on `main` only.
