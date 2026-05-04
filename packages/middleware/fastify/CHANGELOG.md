# @modelcontextprotocol/fastify

## 2.0.0-alpha.3

### Patch Changes

- [#1898](https://github.com/modelcontextprotocol/typescript-sdk/pull/1898) [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add top-level `types`
  field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries
  for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.

- Updated dependencies [[`434b2f1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/434b2f11ecec452f3dca0199f68afccd8b119dd4), [`db83829`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db83829c5bd5d6659c5e7b96638b11953b0e262d),
  [`42cb6b2`](https://github.com/modelcontextprotocol/typescript-sdk/commit/42cb6b2b728347d8b58a0d1940b7e63366a29ab9), [`df4b6cc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/df4b6cc88d6f24fc857519cf506a7a039f532637),
  [`2c0c481`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2c0c481cb9dbfd15c8613f765c940a5f5bace94d), [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52),
  [`e15a8ef`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e15a8ef3be19520d8159ae9f5b464ba3ac80a5ab), [`96db044`](https://github.com/modelcontextprotocol/typescript-sdk/commit/96db044fe965f0b7d5109e6d68598eaddce961c9),
  [`9fc9070`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9fc9070b7b8e18227127aaee9869f8809a87fdb1), [`55b1f06`](https://github.com/modelcontextprotocol/typescript-sdk/commit/55b1f06cd4569e334f3435b7971f0446f1ef9be9),
  [`b256546`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b256546750277faeb7c886792aae5ed26e6904d5)]:
    - @modelcontextprotocol/server@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- [#1840](https://github.com/modelcontextprotocol/typescript-sdk/pull/1840) [`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tsdown exports resolution
  fix

- Updated dependencies [[`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb)]:
    - @modelcontextprotocol/server@2.0.0-alpha.2

## 2.0.0-alpha.1

### Minor Changes

- [#1536](https://github.com/modelcontextprotocol/typescript-sdk/pull/1536) [`81e4b2a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/81e4b2a412ab52ada436061502dd711a67555519) Thanks [@andyfleming](https://github.com/andyfleming)! - Add Fastify middleware adapter
  for MCP servers, following the same pattern as the Express and Hono adapters.

### Patch Changes

- Updated dependencies [[`e86b183`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e86b1835ccf213c3799ac19f4111d01816912333), [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4),
  [`3466a9e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3466a9e0e5d392824156d9b290863ae08192d87e), [`fcde488`](https://github.com/modelcontextprotocol/typescript-sdk/commit/fcde4882276cb0a7d199e47f00120fe13f7f5d47),
  [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e), [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2),
  [`78bae74`](https://github.com/modelcontextprotocol/typescript-sdk/commit/78bae7426d4ca38216c0571b5aa7806f58ab81e4), [`689148d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/689148dc7235f53244869ed64b2ecc9ec4ef70f1),
  [`f1ade75`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f1ade75b67a2b46b06316fa4e5caa1d277537cc7), [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51),
  [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a), [`f66a55b`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f66a55b5f4eb7ce0f8b3885633bf9a7b1080e0b5),
  [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e), [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e),
  [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a), [`0784be1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0784be1a67fb3cc2aba0182d88151264f4ea73c8),
  [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac)]:
    - @modelcontextprotocol/server@2.0.0-alpha.1
