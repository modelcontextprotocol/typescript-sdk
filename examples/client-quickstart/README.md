# client-quickstart

Source for the [Client Quickstart](../../docs/client-quickstart.md) tutorial: an LLM-powered chatbot that connects to an MCP server over stdio and calls its tools. The tutorial walks through `src/index.ts` end to end.

The `package.json` and `tsconfig.json` here are monorepo-internal (`workspace:`/`catalog:` protocols; typecheck-only in CI). To build the client yourself, use the standalone manifests from the tutorial.
