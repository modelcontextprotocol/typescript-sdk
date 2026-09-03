# Versioning Policy

The MCP TypeScript SDK follows [Semantic Versioning 2.0.0](https://semver.org/) for every published package.

## Packages and Version Groups

The v2 SDK is a monorepo. Versions are managed with [Changesets](https://github.com/changesets/changesets) (`.changeset/`):

- `@modelcontextprotocol/core`, `client`, `server`, `server-legacy` and `codemod` form a **fixed group** and always release together with the same version.
- The framework integrations `@modelcontextprotocol/node`, `express`, `hono` and `fastify` are versioned through Changesets alongside the fixed group: they bump whenever their `@modelcontextprotocol/server` peer range has to move, and independently for their own changes.
- `@modelcontextprotocol/core-internal` is private and carries no compatibility promise; the `@modelcontextprotocol/core/internal` entry point is likewise not covered by this policy and may change in any release.
- The `v1.x` branch continues to publish `@modelcontextprotocol/sdk` 1.x under the same rules (patch releases on `release-X.Y` npm tags; see `CONTRIBUTING.md`).

## Version Format

`MAJOR.MINOR.PATCH`

- **MAJOR**: Incremented for breaking changes (see below).
- **MINOR**: Incremented for new features that are backward-compatible.
- **PATCH**: Incremented for backward-compatible bug fixes.

## What Constitutes a Breaking Change

The following changes are considered breaking and require a major version bump:

- Removing or renaming a public API export (class, function, type, or constant).
- Changing the signature of a public function or method in a way that breaks existing callers (removing parameters, changing required/optional status, changing types).
- Removing or renaming a public type or interface field.
- Changing the behavior of an existing API in a way that breaks documented contracts.
- Dropping support for a Node.js LTS version.
- Removing support for a transport type.
- Dropping support for an MCP protocol revision the SDK previously negotiated (see `docs/protocol-versions.md`).

The following are **not** considered breaking:

- Adding new optional parameters to existing functions.
- Adding new exports, types, or interfaces.
- Adding new optional fields to existing types.
- Bug fixes that correct behavior to match documented intent.
- Internal refactoring that does not affect the public API.
- Adding support for new MCP spec revisions or features.
- Changes to dev dependencies or build tooling.

## How Breaking Changes Are Communicated

1. **Changelog**: Every consumer-facing change ships with a changeset; the per-package `CHANGELOG.md` and the GitHub release for each package tag document breaking changes with migration instructions.
2. **Deprecation**: When feasible, APIs are deprecated for at least one minor release before removal using `@deprecated` JSDoc annotations, which surface warnings through TypeScript tooling and editors. Protocol features the specification deprecates stay available for as long as the specification keeps them.
3. **Migration guide**: Major version releases include a migration guide (see `docs/migration/`) and, where practical, a codemod (`@modelcontextprotocol/codemod`).
4. **PR labels**: Pull requests containing breaking changes are labeled with `breaking change`.
