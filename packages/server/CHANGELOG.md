# @modelcontextprotocol/server

## 2.0.0

### Major Changes

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

### Patch Changes

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1372](https://github.com/modelcontextprotocol/typescript-sdk/pull/1372) [`3466a9e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3466a9e0e5d392824156d9b290863ae08192d87e) Thanks [@mattzcarey](https://github.com/mattzcarey)! - missing change for fix(client):
  replace body.cancel() with text() to prevent hanging

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1388](https://github.com/modelcontextprotocol/typescript-sdk/pull/1388) [`f66a55b`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f66a55b5f4eb7ce0f8b3885633bf9a7b1080e0b5) Thanks [@mattzcarey](https://github.com/mattzcarey)! - reverting application/json in
  notifications

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal

- [#1279](https://github.com/modelcontextprotocol/typescript-sdk/pull/1279) [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Initial 2.0.0-alpha.0
  client and server package
