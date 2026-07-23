# @modelcontextprotocol/hono

## 2.0.0-beta.5

### Patch Changes

- Updated dependencies [[`1480241`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1480241e2a2a7f0ceee8e7723b2adcf88579bb36), [`f413763`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f4137630c05dc9a4fb14d4d3777f5cb167bd6313)]:
    - @modelcontextprotocol/server@2.0.0-beta.5

## 2.0.0-beta.4

### Patch Changes

- Updated dependencies [[`7c49b47`](https://github.com/modelcontextprotocol/typescript-sdk/commit/7c49b47fb3a58b51cec8fd0b337f656515f1a2b7), [`e0a0ab7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e0a0ab74d9baed74572c9f435313fb6daef1b989), [`8e1d2e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8e1d2e92b1720d2520122b3a5f20ea084edaf3c4), [`3f07a32`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3f07a325c6741b2374ce2255846dfa0c25f74d03)]:
    - @modelcontextprotocol/server@2.0.0-beta.4

## 2.0.0-beta.3

### Patch Changes

- [#2441](https://github.com/modelcontextprotocol/typescript-sdk/pull/2441) [`561c6d8`](https://github.com/modelcontextprotocol/typescript-sdk/commit/561c6d83456ef98d6c713bbda9837e64337f22c9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - POSTs whose `Content-Type` media type is not `application/json` are now
  rejected with `415 Unsupported Media Type`; the header is parsed instead of
  substring-matched. Previously any value merely containing the substring
  passed the check (for example `text/plain; a=application/json`), case
  variants were wrongly rejected, and the 2026-07-28 entry did not inspect
  `Content-Type` at all — requests with a missing or non-JSON header that used
  to be served on that path now also answer 415. Values with parameters
  (`application/json; charset=utf-8`, including malformed parameter sections
  like `application/json;`) continue to work. SDK clients always send the
  correct header and are unaffected.

    The new `isJsonContentType(header)` helper is exported for transport and
    framework-adapter authors — custom entries composing the exported building
    blocks (`classifyInboundRequest`, `PerRequestHTTPServerTransport`) must apply
    it themselves. The hono adapter's JSON body pre-parse and the client's
    response dispatch now use the same parsed-media-type comparison.

- Updated dependencies [[`44797d7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/44797d77792953d0ce70b68922bb6bb69e697c32), [`1b90c96`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b90c96d11fd17016d2977cae9dd661de3fb84df), [`561c6d8`](https://github.com/modelcontextprotocol/typescript-sdk/commit/561c6d83456ef98d6c713bbda9837e64337f22c9), [`ce2f65d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/ce2f65db0e019506f4d2526466ec8cc7106de98e), [`7e69735`](https://github.com/modelcontextprotocol/typescript-sdk/commit/7e697354de95111ca2c70a12ac9f5d3ec96b56c3), [`e8de519`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e8de519d3129f46b7528d2999b7641f55be1f091), [`0ab5d14`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0ab5d1471d6c7375878316df2930fca77eee1d2a), [`24be404`](https://github.com/modelcontextprotocol/typescript-sdk/commit/24be4040d454a9c5983901229068477c7a9ea796), [`7635115`](https://github.com/modelcontextprotocol/typescript-sdk/commit/7635115d0112c3f980b45a9773a4770660af8aae), [`61866d7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/61866d7a5ff4475663ceb525c88447c497c1b92a)]:
    - @modelcontextprotocol/server@2.0.0-beta.3

## 2.0.0-beta.2

### Patch Changes

- [#2405](https://github.com/modelcontextprotocol/typescript-sdk/pull/2405) [`f172626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f172626a8e98b2ae2f0f690e4afb4dc74dbf6011) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Ship CommonJS builds alongside ESM. Each package now emits both `.mjs`/`.d.mts`
  and `.cjs`/`.d.cts` (via tsdown `format: ['esm', 'cjs']`), and its `exports` map
  adds a `require` condition so `require('@modelcontextprotocol/…')` works from
  CommonJS consumers. Output extensions are normalized across all packages
  (`@modelcontextprotocol/core` moves from `.js`/`.d.ts` to `.mjs`/`.d.mts`); the
  public import paths are unchanged.
- Updated dependencies [[`f172626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f172626a8e98b2ae2f0f690e4afb4dc74dbf6011), [`3c7ddaf`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3c7ddafa05d8f17fb52168bf4638f09251c3d0ff)]:
    - @modelcontextprotocol/server@2.0.0-beta.2

## 2.0.0-beta.1

### Patch Changes

- [#2402](https://github.com/modelcontextprotocol/typescript-sdk/pull/2402) [`a400259`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a4002596b914c675d17ac22471d1287976dbb52a) Thanks [@felixweinberger](https://github.com/felixweinberger)! - First beta release of SDK v2 with support for the MCP 2026-07-28 specification
  revision. See the migration guides for upgrading from v1
  (`docs/migration/upgrade-to-v2.md`) and adopting the 2026-07-28 revision
  (`docs/migration/support-2026-07-28.md`).
- Updated dependencies [[`a400259`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a4002596b914c675d17ac22471d1287976dbb52a)]:
    - @modelcontextprotocol/server@2.0.0-beta.1

## 2.0.0-alpha.4

### Minor Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add Origin header validation alongside the existing Host header validation. The server package gains framework-agnostic helpers (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`); the Express, Hono and Fastify adapters gain `originValidation` /
  `localhostOriginValidation` middleware and a new `allowedOrigins` option on their app factories, which now arm Origin validation by default for localhost-class binds (mirroring the Host validation ladder; the 0.0.0.0-without-allowlist warning is unchanged). Requests
  without an `Origin` header pass — non-browser MCP clients are unaffected — while a present `Origin` that is not allowed or cannot be parsed (including the opaque `null` origin) is rejected with `403`. The Node adapter ships `hostHeaderValidation` / `originValidation`
  request guards for plain `node:http` servers, which previously had no validation helpers.

### Patch Changes

- Updated dependencies [[`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`801111e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/801111ea152c1ba08f6dda0b27d712759aeb46bf), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`6cc7b1c`](https://github.com/modelcontextprotocol/typescript-sdk/commit/6cc7b1cb66cabf23423ba0fdf06e2d1c2fcf936f), [`f0bf785`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f0bf785239af67f0cfce24575fec9c1193deaff1), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771), [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771)]:
    - @modelcontextprotocol/server@2.0.0-alpha.4

## 2.0.0-alpha.3

### Patch Changes

- [#1898](https://github.com/modelcontextprotocol/typescript-sdk/pull/1898) [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add top-level `types`
  field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries
  for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.

- Updated dependencies [[`e8c7180`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e8c7180109b417eef5cc22b7e9d821ab1c119a69), [`434b2f1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/434b2f11ecec452f3dca0199f68afccd8b119dd4),
  [`db83829`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db83829c5bd5d6659c5e7b96638b11953b0e262d), [`e84c3e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e84c3e9ad040eb09299b1f99dd8bdd14251ae790),
  [`42cb6b2`](https://github.com/modelcontextprotocol/typescript-sdk/commit/42cb6b2b728347d8b58a0d1940b7e63366a29ab9), [`c59dc3a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c59dc3aa1a633d27fbbe873f1a430483cf7440f8),
  [`df4b6cc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/df4b6cc88d6f24fc857519cf506a7a039f532637), [`2c0c481`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2c0c481cb9dbfd15c8613f765c940a5f5bace94d),
  [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1), [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52),
  [`e15a8ef`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e15a8ef3be19520d8159ae9f5b464ba3ac80a5ab), [`db28156`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db28156a23032290b3ce3bae00a17544c4807b8f),
  [`49c0a71`](https://github.com/modelcontextprotocol/typescript-sdk/commit/49c0a711c8bf2d385f9e03b4f28ba0ff0d0db0bd), [`c8d7401`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c8d7401b46f34b6c49b7cfb7b321714d0d4048f6),
  [`96db044`](https://github.com/modelcontextprotocol/typescript-sdk/commit/96db044fe965f0b7d5109e6d68598eaddce961c9), [`1b53a41`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b53a415ea2c33aa11ac413fc9c2d68ccffde784),
  [`9fc9070`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9fc9070b7b8e18227127aaee9869f8809a87fdb1), [`16d13ab`](https://github.com/modelcontextprotocol/typescript-sdk/commit/16d13abf78b5dba5de73dfa284325b13d4219bb2),
  [`55b1f06`](https://github.com/modelcontextprotocol/typescript-sdk/commit/55b1f06cd4569e334f3435b7971f0446f1ef9be9), [`b256546`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b256546750277faeb7c886792aae5ed26e6904d5)]:
    - @modelcontextprotocol/server@2.0.0-alpha.3

## 2.0.0-alpha.2

### Patch Changes

- [#1840](https://github.com/modelcontextprotocol/typescript-sdk/pull/1840) [`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tsdown exports resolution
  fix

- Updated dependencies [[`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb)]:
    - @modelcontextprotocol/server@2.0.0-alpha.2

## 2.0.0-alpha.1

### Patch Changes

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

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
