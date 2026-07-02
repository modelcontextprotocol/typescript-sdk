# client-quickstart

An LLM-powered chatbot that connects to an MCP server over stdio and calls its tools (`src/index.ts`). It was the source for the retired client-quickstart tutorial; the current getting-started tutorial is [Build your first client](../../docs/get-started/first-client.md).

The `package.json` and `tsconfig.json` here are monorepo-internal (`workspace:`/`catalog:` protocols; typecheck-only in CI). To build the client yourself outside the monorepo, copy `src/index.ts` into a standalone project that depends on the published packages.
