# server-quickstart

Source for the [Server Quickstart](../../docs/server-quickstart.md) tutorial: a stdio weather server exposing `get-alerts` and `get-forecast` tools. The tutorial walks through `src/index.ts` end to end.

The `package.json` and `tsconfig.json` here are monorepo-internal (`workspace:`/`catalog:` protocols; typecheck-only in CI). To build the server yourself, use the standalone manifests from the tutorial.
