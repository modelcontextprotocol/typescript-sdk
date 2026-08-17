# Dependency Policy

As a library consumed by downstream projects, the MCP TypeScript SDK takes a conservative approach to dependency updates. Dependencies are kept stable unless there is a specific reason to update, such as a security vulnerability, a bug fix, or a need for new functionality.

This policy applies to every published package in this monorepo (`@modelcontextprotocol/core`, `client`, `server`, `server-legacy`, `codemod`, `node`, `express`, `hono`, `fastify`) and to the `v1.x` maintenance line (`@modelcontextprotocol/sdk`).

## Update Triggers

Dependencies are updated when:

- A **security vulnerability** is disclosed (via GitHub security alerts).
- A bug in a dependency directly affects the SDK.
- A new dependency feature is needed for SDK development.
- A dependency drops support for a Node.js version the SDK still targets.
- A new MCP specification revision requires it.

Routine version bumps without a clear motivation are avoided to minimize churn for downstream consumers.

## What We Don't Do

The SDK does not run scheduled version bumps for npm dependencies. Updating a dependency can force downstream consumers to adopt that update transitively, which can be disruptive for projects with strict dependency policies.

Dependencies are only updated when there is a concrete reason, not simply because a newer version is available.

## Automated Tooling

- **GitHub security updates** are enabled at the repository level and automatically open pull requests for npm packages with known vulnerabilities. This is a GitHub repo setting, separate from the `dependabot.yml` configuration.
- **GitHub Actions versions** are kept up to date via Dependabot on a weekly schedule (see `.github/dependabot.yml`).
- **Supply-chain cooldown**: pnpm's `minimumReleaseAge` (see `pnpm-workspace.yaml`) keeps newly published versions out of the lockfile for 7 days, and only an allow-listed set of dependencies may run install scripts (`onlyBuiltDependencies`).

## Pinning and Ranges

Dependency ranges live in the pnpm workspace catalogs (`pnpm-workspace.yaml`), so a version is declared once and shared by every package. Runtime dependencies use caret ranges (`^`) to allow compatible updates within a major version. Exact versions are pinned only when necessary to work around a specific issue. Framework integrations (`express`, `hono`, `fastify`) declare the framework as a peer dependency rather than bundling a copy.

Runtime dependencies of published packages are kept to a minimum; adding one is a design decision discussed in an issue first (see `CONTRIBUTING.md`).
