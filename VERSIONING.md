# Versioning Policy

The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) follows [Semantic Versioning 2.0.0](https://semver.org/).

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
- Changes to the MCP protocol version that require client/server code changes.

The following are **not** considered breaking:

- Adding new optional parameters to existing functions.
- Adding new exports, types, or interfaces.
- Adding new optional fields to existing types.
- Bug fixes that correct behavior to match documented intent.
- Internal refactoring that does not affect the public API.
- Adding support for new MCP spec features.
- Changes to dev dependencies or build tooling.

## How Breaking Changes Are Communicated

1. **Changelog**: All breaking changes are documented in the GitHub release notes with migration instructions.
2. **Deprecation**: When feasible, APIs are deprecated for at least one minor release before removal. Deprecated APIs emit console warnings.
3. **Migration guide**: Major version releases include a migration guide describing what changed and how to update.
4. **PR labels**: Pull requests containing breaking changes are labeled with `breaking change`.

## MCP Spec Version Tracking

The SDK tracks the MCP specification version. When the spec introduces breaking changes:

- The SDK updates to support the new spec version in a minor release (adding support).
- Removal of support for old spec versions is a breaking change (major release).
- The SDK's `LATEST_PROTOCOL_VERSION` constant reflects the current supported spec version.

## Release Process

1. Changes are merged to the `main` branch via pull requests.
2. Releases are published to npm from the `main` branch.
3. Release notes are generated from PR descriptions and conventional commit messages.
4. The `v1.x` branch is maintained for the current major version line.
