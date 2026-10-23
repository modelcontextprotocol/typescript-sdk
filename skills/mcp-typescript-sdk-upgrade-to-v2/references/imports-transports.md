### Imports & transports

The codemod rewrites every `@modelcontextprotocol/sdk/...` import path via
[`importMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts).
A few transports need a decision the codemod can't make:

- **`StreamableHTTPServerTransport` → which runtime?** The codemod renames it to
  `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`. If you deploy
  to a web-standard runtime (Cloudflare Workers, Deno, Bun), use
  `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`
  instead. **Decision rule:** if your handler receives a Node `IncomingMessage` /
  `ServerResponse`, use `@modelcontextprotocol/node`; if it receives a web-standard
  `Request` and returns a `Response`, use `@modelcontextprotocol/server`.
- **stdio transports moved to a `./stdio` subpath.** Import `StdioClientTransport`,
  `getDefaultEnvironment`, `DEFAULT_INHERITED_ENV_VARS`, and `StdioServerParameters`
  from `@modelcontextprotocol/client/stdio`; import `StdioServerTransport` from
  `@modelcontextprotocol/server/stdio`. The package root barrels do **not** export
  these (the root entries are runtime-neutral so browser/Workers bundlers can consume
  them). The stdio utilities `ReadBuffer`, `serializeMessage`, `deserializeMessage`
  stay in the root barrel.
- **Zod `*Schema` constants → `@modelcontextprotocol/core`.** A mixed
  `import { CallToolResult, CallToolResultSchema } from '…/types.js'` is split by the
  codemod — see [Types & schemas](types-schemas.md#types--schemas).

    ```typescript
    // v1
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    // v2
    import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
    ```

- **`SSEServerTransport`** is removed. Migrate to Streamable HTTP. A frozen v1 copy is
  available from `@modelcontextprotocol/server-legacy/sse` as a temporary bridge.
- **`WebSocketClientTransport`** is removed (WebSocket is not a spec transport). Use
  `StreamableHTTPClientTransport` for remote servers or `StdioClientTransport` for
  local servers; the `Transport` interface is exported if you need a custom
  implementation.
- **`InMemoryTransport`** is now exported from `@modelcontextprotocol/client` and
  `@modelcontextprotocol/server` (both re-export it). The two packages bundle separate
  copies with private state, so the halves of a linked pair must come from the **same
  package's** import — pick one package per file (per linked pair) rather than mixing
  the client's `InMemoryTransport` with the server's:

    ```typescript
    // v1
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    // v2
    import { InMemoryTransport } from '@modelcontextprotocol/server'; // or /client
    ```

- **`EventStore`, `StreamId`, `EventId`** are exported from `@modelcontextprotocol/server`
  only (v1 re-exported them alongside the transport from `sdk/server/streamableHttp.js`;
  `@modelcontextprotocol/node` does not).
- **Client fetch middleware moved to the root barrel.** `createMiddleware`,
  `applyMiddlewares`, `withLogging`, `withOAuth`, and the `Middleware` type (v1:
  `sdk/client/middleware.js`) are now exported from `@modelcontextprotocol/client`
  directly, as is `FetchLike` (v1: `sdk/shared/transport.js`). The call signatures are
  unchanged from v1 (`Middleware` is still `(next: FetchLike) => FetchLike`) — only the
  import path changes.
- **Server auth split.** Resource Server helpers (`requireBearerAuth`,
  `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`)
  → `@modelcontextprotocol/express`; the runtime-neutral core (`requireBearerAuth`
  for web-standard `fetch` hosts, `verifyBearerToken`, `bearerAuthChallengeResponse`,
  `OAuthTokenVerifier`, and the discovery serving `oauthMetadataResponse` /
  `buildOAuthProtectedResourceMetadata` / `getOAuthProtectedResourceMetadataUrl`)
  is also exported from `@modelcontextprotocol/server`. Authorization Server helpers (`mcpAuthRouter`,
  `OAuthServerProvider`, `ProxyOAuthServerProvider`, `allowedMethods`,
  `authenticateClient`, `metadataHandler`, `createOAuthMetadata`,
  `authorizationHandler` / `tokenHandler` / `revocationHandler` /
  `clientRegistrationHandler`) → `@modelcontextprotocol/server-legacy/auth`
  (deprecated, frozen v1 copy); migrate AS to a dedicated IdP/OAuth library. `AuthInfo`
  is now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`.

    The codemod's [`importMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts)
    routes every `…/server/auth/**` deep path (including
    `…/server/auth/middleware/{bearerAuth,allowedMethods,clientAuth}.js`,
    `…/server/auth/handlers/*.js`, `…/server/auth/providers/proxyProvider.js`) to
    `@modelcontextprotocol/server-legacy/auth`, and `…/server/express.js` /
    `…/server/middleware/hostHeaderValidation.js` to `@modelcontextprotocol/express`. The
    AS→`server-legacy` routing is conservative — re-point RS-only call sites
    (`requireBearerAuth`, `mcpAuthMetadataRouter`) at `@modelcontextprotocol/express` by hand.
    Staying on the frozen `server-legacy/auth` copy is a supported interim choice when you
    deliberately want the v1 middleware behavior. If you re-point at
    `@modelcontextprotocol/express` by hand, also add that package — plus its `express`
    peer dependency — to your manifest: the codemod's manifest summary reflects only the
    imports it wrote, not re-points you make afterwards.
