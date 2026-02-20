# @modelcontextprotocol/node

## 2.0.0

### Patch Changes

- [#1504](https://github.com/modelcontextprotocol/typescript-sdk/pull/1504) [`327243c`](https://github.com/modelcontextprotocol/typescript-sdk/commit/327243cebd96e07686c88f7fa9ca22a5a7a7993d) Thanks [@corvid-agent](https://github.com/corvid-agent)! - Add missing `hono` peer
  dependency to `@modelcontextprotocol/node`. The package already depends on `@hono/node-server` which requires `hono` at runtime, but `hono` was only listed in the workspace root, not as a peer dependency of the package itself.

- [#1410](https://github.com/modelcontextprotocol/typescript-sdk/pull/1410) [`9296459`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9296459ac006546499f6b4105ffc528b8c212d88) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Prevent Hono from overriding
  global Response object by passing `overrideGlobalObjects: false` to `getRequestListener()`. This fixes compatibility with frameworks like Next.js whose response classes extend the native Response.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal

- Updated dependencies [[`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4), [`3466a9e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3466a9e0e5d392824156d9b290863ae08192d87e),
  [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a), [`f66a55b`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f66a55b5f4eb7ce0f8b3885633bf9a7b1080e0b5),
  [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a), [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac)]:
    - @modelcontextprotocol/server@2.0.0
