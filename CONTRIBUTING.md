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

## Strict Transport Declaration Checks

Build with `npm run build`, then install the packed SDK in an isolated consumer directory. Run the generic public-export checks with the desired TypeScript CLI:

```sh
npx tsx scripts/test-transport-types.ts /path/to/consumer /path/to/typescript/bin/tsc
```

The consumer directory must contain the installed SDK and `@types/node`. The checks use `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `skipLibCheck: false` with ES2022 and NodeNext. They check Node-only and DOM library
configurations, ESM and CJS public exports, callback clearing, invalid callback/header types, and declaration emission followed by a second consumer with no access to the first consumer's source.

`Transport` callbacks may be omitted or explicitly cleared with `undefined`, matching the Node HTTP transport accessors. Its session ID may also be absent or `undefined`. `normalizeHeaders` uses the standard `Headers`, tuple-array, and string-record forms directly so Node
consumers do not need the DOM-only `HeadersInit` alias.

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
