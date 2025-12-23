# Contributing to MCP TypeScript SDK

We welcome contributions to the Model Context Protocol TypeScript SDK! This document outlines the process for contributing to the project.

## Branches

This repository has two main branches:

- **`main`** – v2 of the SDK (currently in development). This is a monorepo with split packages.
- **`v1.x`** – stable v1 release. Bug fixes and patches for v1 should target this branch.

**Which branch should I use as a base?**

- For **new features** or **v2-related work**: base your PR on `main`
- For **v1 bug fixes** or **patches**: base your PR on `v1.x`

## Getting Started

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

## Development Process

1. Create a new branch for your changes (based on `main` or `v1.x` as appropriate)
2. Make your changes
3. Run `pnpm lint:all` to ensure code style compliance
4. Run `pnpm test:all` to verify all tests pass
5. Submit a pull request

## Pull Request Guidelines

- Follow the existing code style
- Include tests for new functionality
- Update documentation as needed
- Keep changes focused and atomic
- Provide a clear description of changes

## Running Examples

See [`examples/server/README.md`](examples/server/README.md) and [`examples/client/README.md`](examples/client/README.md) for a full list of runnable examples.

Quick start:

```bash
# Run a server example
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts

# Run a client example (in another terminal)
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleStreamableHttp.ts
```

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). Please review it before contributing.

## Reporting Issues

- Use the [GitHub issue tracker](https://github.com/modelcontextprotocol/typescript-sdk/issues)
- Search existing issues before creating a new one
- Provide clear reproduction steps

## Security Issues

Please review our [Security Policy](SECURITY.md) for reporting security vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
