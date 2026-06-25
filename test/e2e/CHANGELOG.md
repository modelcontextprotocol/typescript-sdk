# @modelcontextprotocol/test-e2e

## 2.0.0-alpha.1

### Patch Changes

- [#2203](https://github.com/modelcontextprotocol/typescript-sdk/pull/2203) [`4a5c863`](https://github.com/modelcontextprotocol/typescript-sdk/commit/4a5c863a21f06e3ae43db116f32f2da7df5988b4) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add consumer-sourced
  e2e requirements (behaviors real SDK dependents rely on) and run the interaction matrix over the legacy HTTP+SSE transport, with known failures recording where v2 intentionally differs.

- [#2179](https://github.com/modelcontextprotocol/typescript-sdk/pull/2179) [`1998a18`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1998a186eeb8aa3728c1e82420e381e0f9b80a83) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the end-to-end
  behavior test suite as a workspace package: a requirements manifest covering protocol-visible SDK behavior across the in-memory, stdio, and Streamable HTTP transports, ported from the v1.x branch and extended with coverage for v2 features.
