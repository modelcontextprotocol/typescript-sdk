# Contributing to MCP TypeScript SDK

We welcome contributions to the Model Context Protocol TypeScript SDK! This document outlines the process for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR-USERNAME/typescript-sdk.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Run tests: `npm test`

## Development Process

1. Create a new branch for your changes
2. Make your changes
3. Run `npm run lint` to ensure code style compliance
4. Run `npm test` to verify all tests pass
5. Submit a pull request

## Pull Request Guidelines

- Follow the existing code style
- Include tests for new functionality
- Update documentation as needed
- Keep changes focused and atomic
- Provide a clear description of changes

## Good to know

Details about this branch that neither the code nor the tools will tell you.

- **Tests** — Tests live under `test/`, mirroring `src/`; a test file next to its source never runs.
- **Imports** — Relative imports carry the `.js` extension; the compiler accepts them without it, Node does not.
- **Public surface** — Everything under `src/` is reachable by users, because `package.json` exports `./*`.
- **Zod** — User-supplied schemas may be Zod v3 or v4; `src/server/zod-compat.ts` handles both.
- **Both lines** — A fix that also applies to v2 lands on `main` as well.

## Running Examples

- Start the server: `npm run server`
- Run the client: `npm run client`

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
