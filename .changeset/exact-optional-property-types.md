---
"@modelcontextprotocol/core": patch
"@modelcontextprotocol/server": patch
---

fix: support `exactOptionalPropertyTypes` TypeScript config

Adds `| undefined` to optional callback properties in the `Transport` interface
and `WebStandardStreamableHTTPServerTransportOptions` to support projects using
`exactOptionalPropertyTypes: true` in their tsconfig.

This allows explicitly passing `undefined` for optional callbacks like
`sessionIdGenerator`, `onclose`, `onerror`, and `onmessage`.

Fixes #1397
