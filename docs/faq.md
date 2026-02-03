---
title: FAQ
---

## FAQ

<details>
<summary>Table of Contents</summary>

- [General](#general)
- [Clients](#clients)
- [Servers](#servers)
- [v1 (legacy)](#v1-legacy)

</details>

## General

### Why do I see `TS2589: Type instantiation is excessively deep and possibly infinite` after upgrading the SDK?

This TypeScript error can appear when upgrading to newer SDK versions that support Zod v4 (for example, from older `@modelcontextprotocol/sdk` releases to newer `@modelcontextprotocol/client` / `@modelcontextprotocol/server` releases) **and** your project ends up with multiple
`zod` versions in the dependency tree.

When there are multiple copies or versions of `zod`, TypeScript may try to instantiate very complex, cross-version types and hit its recursion limits, resulting in `TS2589`. This scenario is discussed in GitHub issue
[#1180](https://github.com/modelcontextprotocol/typescript-sdk/issues/1180#event-21236550401).

To diagnose and fix this:

- **Inspect your installed `zod` versions**:
    - Run `npm ls zod` or `npm explain zod`, `pnpm list zod` or `pnpm why zod`, or `yarn why zod` and check whether more than one version is installed.
- **Align on a single `zod` version**:
    - Make sure all packages that depend on `zod` use a compatible version range so that your package manager can hoist a single copy.
    - In monorepos, consider declaring `zod` at the workspace root and using compatible ranges in individual packages.
- **Use overrides/resolutions if necessary**:
    - With npm, Yarn, or pnpm, you can use `overrides` / `resolutions` to force a single `zod` version if some transitive dependencies pull in a different one.

Once your project is using a single, compatible `zod` version, the `TS2589` error should no longer occur.

## Clients

### How do I enable Web Crypto (`globalThis.crypto`) for client authentication in older Node.js versions?

The SDK’s OAuth client authentication helpers (for example, those in `packages/client/src/client/auth-extensions.ts` that use `jose`) rely on the Web Crypto API exposed as `globalThis.crypto`. This is especially important for **client credentials** and **JWT-based**
authentication flows used by MCP clients.

- **Node.js v19.0.0 and later**: `globalThis.crypto` is available by default.
- **Node.js v18.x**: `globalThis.crypto` may not be defined by default. In this repository we polyfill it for tests (see `packages/client/vitest.setup.js`), and you should do the same in your app if it is missing – or alternatively, run Node with `--experimental-global-webcrypto`
  as per your Node version documentation. (See https://nodejs.org/dist/latest-v18.x/docs/api/globals.html#crypto )

If you run clients on Node.js versions where `globalThis.crypto` is missing, you can polyfill it using the built-in `node:crypto` module, similar to the SDK's own `vitest.setup.ts`:

```typescript
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).crypto = webcrypto as unknown as Crypto;
}
```

For production use, you can either:

- Run clients on a Node.js version where `globalThis.crypto` is available by default (recommended), or
- Apply a similar polyfill early in your client's startup code when targeting older Node.js runtimes, so that OAuth client authentication works reliably.

## Servers

### Where can I find runnable server examples?

The SDK ships several runnable server examples under `examples/server/src`. Start from the server examples index in [`examples/server/README.md`](../examples/server/README.md) and the entry-point quick start in the root [`README.md`](../README.md).

### Why did we remove `server` auth exports?

Server authentication & authorization is outside of the scope of the SDK, and the recommendation is to use packages that focus on this area specifically (or a full-fledged Authorization Server for those who use such). Example packages provide an example with `better-auth`.

### Why did we remove `server` SSE transport?

The SSE transport has been deprecated for a long time, and `v2` will not support it on the server side any more. Client side will keep supporting it in order to be able to connect to legacy SSE servers via the `v2` SDK, but serving SSE from `v2` will not be possible. Servers
wanting to switch to `v2` and using SSE should migrate to Streamable HTTP.

## v1 (legacy)

### Where do v1 documentation and v1-specific fixes live?

The v1 generation of this SDK is maintained on the long-lived [`v1.x` branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). If you’re using v1, refer to that branch for documentation and any v1-specific fixes.
