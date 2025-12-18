# Contributing to MCP TypeScript SDK

Welcome, and thanks for your interest in contributing! We're glad you're here.

This document outlines how to contribute effectively to the TypeScript SDK.

## Issues

### Discuss Before You Code

**Please open an issue before starting work on new features or significant changes.** This gives us a chance to align on approach and save you time if we see potential issues.

We'll close PRs for undiscussed features—not because we don't appreciate the effort, but because every merged feature becomes an ongoing maintenance burden for our small team of volunteer maintainers. Talking first helps us figure out together whether something belongs in the
SDK.

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

### Scope

Small PRs get reviewed fast. Large PRs sit in the queue.

We can review a few dozen lines in a few minutes. But a PR touching hundreds of lines across many files takes real effort to verify—and things inevitably slip through. If your change is big, break it into a stack of smaller PRs or get clear alignment from a maintainer on your
approach in an issue before submitting a large PR.

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

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/typescript-sdk.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run tests: `npm test`

### Workflow

1. Create a new branch for your changes
2. Make your changes
3. Run `npm run lint` to ensure code style compliance
4. Run `npm test` to verify all tests pass
5. Submit a pull request

### Running Examples

- Start the server: `npm run server`
- Run the client: `npm run client`

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

By contributing, you agree that your contributions will be licensed under the MIT License.
