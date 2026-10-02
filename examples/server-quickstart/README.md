# server-quickstart

A stdio weather server exposing `get-alerts` and `get-forecast` tools (`src/index.ts`). It was the source for the retired server-quickstart tutorial; the current getting-started tutorial is [Build your first server](../../docs/get-started/first-server.md).

The `package.json` and `tsconfig.json` here are monorepo-internal (`workspace:`/`catalog:` protocols; typecheck-only in CI). To build the server yourself outside the monorepo, copy `src/index.ts` into a standalone project that depends on the published packages.
