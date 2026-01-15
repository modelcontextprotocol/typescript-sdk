# Contributing to MCP TypeScript SDK

Welcome, and thanks for your interest in contributing! We're glad you're here.

This document outlines how to contribute effectively to the TypeScript SDK.

## Issues

### Discuss Before You Code

**Please open an issue before starting work on new features or significant changes.** This gives us a chance to align on approach and save you time if we see potential issues.

We'll close PRs for undiscussed features—not because we don't appreciate the effort, but because every merged feature becomes an ongoing maintenance burden for our small team of maintainers. Talking first helps us figure out together whether something belongs in the SDK.

Straightforward bug fixes (a few lines of code with tests demonstrating the fix) can skip this step. For complex bugs that need significant changes, consider opening an issue first.

### What Counts as "Significant"?

- New public APIs or classes
- Architectural changes or refactoring
- Changes that touch multiple modules
- Features that might require spec changes (these need a [SEP](https://modelcontextprotocol.io/community/sep-guidelines) first)

### Writing Good Issues

Help us help you:

- Lead with what's broken or what you need
- Include code we can run to see the problem
- Keep it focused—a clear problem statement goes a long way

We're a small team, so issues that include some upfront debugging help us move faster. Low-effort or obviously AI-generated issues will be closed.

### Finding Issues to Work On

| Label                                                                                                                                     | For                      | Description                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------- |
| [`good first issue`](https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22) | Newcomers                | Can tackle without deep codebase knowledge    |
| [`help wanted`](https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22)           | Experienced contributors | Maintainers probably won't get to this        |
| [`ready for work`](https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aopen+is%3Aissue+label%3A%22ready+for+work%22)     | Maintainers              | Triaged and ready for a maintainer to pick up |

Issues labeled `needs confirmation`, `needs repro`, or `needs design` are **not** ready for work—wait for maintainer input before starting.

Before starting work, comment on the issue so we can assign it to you. This lets others know and avoids duplicate effort.

## Pull Requests

By the time you open a PR, the "what" and "why" should already be settled in an issue. This keeps PR reviews focused on implementation rather than revisiting whether we should do it at all.

### Branches

This repository has two main branches:

- **`main`** – v2 of the SDK (currently in development). This is a monorepo with split packages.
- **`v1.x`** – stable v1 release. Bug fixes and patches for v1 should target this branch.

**Which branch should I use as a base?**

- For **new features** or **v2-related work**: base your PR on `main`
- For **v1 bug fixes** or **patches**: base your PR on `v1.x`

### Scope

Small PRs get reviewed fast. Large PRs sit in the queue.

We can review a few dozen lines in a few minutes. But a PR touching hundreds of lines across many files takes real effort to verify—and things inevitably slip through. If your change is big, break it into a stack of smaller PRs or get clear alignment from a maintainer on your approach in an issue before submitting a large PR.

### What Gets Rejected

PRs may be rejected for:

- **Lack of prior discussion** — Features or significant changes without an approved issue
- **Scope creep** — Changes that go beyond what was discussed or add unrequested features
- **Misalignment with SDK direction** — Even well-implemented features may be rejected if they don't fit the SDK's goals
- **Insufficient quality** — Code that doesn't meet clarity, maintainability, or style standards
- **Overengineering** — Unnecessary complexity or abstraction for simple problems

### Submitting Your PR

1. Follow the existing code style
2. Include tests for new functionality
3. Update documentation as needed
4. Keep changes focused and atomic
5. Provide a clear description of changes

## Development

### Getting Started

This project uses [pnpm](https://pnpm.io/) as its package manager. If you don't have pnpm installed, enable it via [corepack](https://nodejs.org/api/corepack.html) (included with Node.js 16.9+):

```bash
corepack enable
```

Then:

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/typescript-sdk.git`
3. Install dependencies: `pnpm install`
4. Build the project: `pnpm build:all`
5. Run tests: `pnpm test:all`

### Workflow

1. Create a new branch for your changes (based on `main` or `v1.x` as appropriate)
2. Make your changes
3. Run `pnpm lint:all` to ensure code style compliance
4. Run `pnpm test:all` to verify all tests pass
5. Submit a pull request

### Running Examples

See [`examples/server/README.md`](examples/server/README.md) and [`examples/client/README.md`](examples/client/README.md) for a full list of runnable examples.

Quick start:

```bash
# Run a server example
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts

# Run a client example (in another terminal)
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleStreamableHttp.ts
```

## Releasing v1.x Patches

The `v1.x` branch contains the stable v1 release. To release a patch:

### Latest v1.x (e.g., v1.25.3)

```bash
git checkout v1.x
git pull origin v1.x
# Apply your fix or cherry-pick commits
npm version patch      # Bumps version and creates tag (e.g., v1.25.3)
git push origin v1.x --tags
```

The tag push automatically triggers the release workflow.

### Older minor versions (e.g., v1.23.2)

For patching older minor versions that aren't on the `v1.x` branch:

```bash
# 1. Create a release branch from the last release tag
git checkout -b release/1.23 v1.23.1

# 2. Apply your fixes (cherry-pick or manual)
git cherry-pick <commit-hash>

# 3. Bump version and push
npm version patch      # Creates v1.23.2 tag
git push origin release/1.23 --tags
```

Then manually trigger the "Publish v1.x" workflow from [GitHub Actions](https://github.com/modelcontextprotocol/typescript-sdk/actions/workflows/release-v1x.yml), specifying the tag (e.g., `v1.23.2`).

### npm Tags

v1.x releases are published with `release-X.Y` npm tags (e.g., `release-1.25`), not `latest`. To install a specific minor version:

```bash
npm install @modelcontextprotocol/sdk@release-1.25
```

## Policies

### Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). Please review it before contributing.

### Reporting Issues

- Use the [GitHub issue tracker](https://github.com/modelcontextprotocol/typescript-sdk/issues)
- Search existing issues before creating a new one
- Provide clear reproduction steps

### Security Issues

Please review our [Security Policy](SECURITY.md) for reporting security vulnerabilities.

### License

By contributing, you agree that your code contributions will be licensed under
the Apache License 2.0. Documentation contributions (excluding specifications)
are licensed under CC-BY 4.0. See the [LICENSE](LICENSE) file for details.
