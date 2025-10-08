# MCP TypeScript SDK Guide

## Build & Test Commands

```sh
npm run build        # Build ESM and CJS versions
npm run lint         # Run ESLint
npm test             # Run all tests
npm test:coverage    # Run coverage of all tests
npm test:bench       # Run all benchmark tests
npx vitest path/to/file.test.ts  # Run specific test file
npx vitest -t "test name"        # Run tests matching pattern
```

## Code Style Guidelines

- **TypeScript**: Strict type checking, ES modules, explicit return types
- **Naming**: PascalCase for classes/types, camelCase for functions/variables
- **Files**: Lowercase with hyphens, test files with `.test.ts` suffix, benchmark files with `.bench.ts` suffix
- **Imports**: ES module style, include `.js` extension, group imports logically
- **Error Handling**: Use TypeScript's strict mode, explicit error checking in tests
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
- **Testing**: Co-locate tests with source files, use descriptive test names
- **Comments**: JSDoc for public APIs, inline comments for complex logic

## Project Structure

- `/src`: Source code with client, server, and shared modules
- Tests alongside source files with `.test.ts` suffix
- Benchmark tests alongside source files with `.bench.ts` suffix
- Node.js >= 18 required
