# @modelcontextprotocol/core

## 2.0.0

### Minor Changes

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

### Patch Changes

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1486](https://github.com/modelcontextprotocol/typescript-sdk/pull/1486) [`65bbcea`](https://github.com/modelcontextprotocol/typescript-sdk/commit/65bbceab773277f056a9d3e385e7e7d8cef54f9b) Thanks [@localden](https://github.com/localden)! - Fix InMemoryTaskStore to enforce
  session isolation. Previously, sessionId was accepted but ignored on all TaskStore methods, allowing any session to enumerate, read, and mutate tasks created by other sessions. The store now persists sessionId at creation time and enforces ownership on all reads and writes.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal
