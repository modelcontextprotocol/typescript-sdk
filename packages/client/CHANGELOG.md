# @modelcontextprotocol/client

## 2.0.0-alpha.2

### Patch Changes

- [#1840](https://github.com/modelcontextprotocol/typescript-sdk/pull/1840) [`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tsdown exports resolution
  fix

## 2.0.0-alpha.1

### Major Changes

- [#1783](https://github.com/modelcontextprotocol/typescript-sdk/pull/1783) [`045c62a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/045c62a1e0ada756afe90dd1442534e362269dbf) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Remove
  `WebSocketClientTransport`. WebSocket is not a spec-defined transport; use stdio or Streamable HTTP. The `Transport` interface remains exported for custom implementations. See #142.

### Minor Changes

- [#1527](https://github.com/modelcontextprotocol/typescript-sdk/pull/1527) [`dc896e1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dc896e198bdd1367d93a7c38846fdf9e78d84c6a) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add
  `discoverOAuthServerInfo()` function and unified discovery state caching for OAuth
    - New `discoverOAuthServerInfo(serverUrl)` export that performs RFC 9728 protected resource metadata discovery followed by authorization server metadata discovery in a single call. Use this for operations like token refresh and revocation that need the authorization server
      URL outside of `auth()`.
    - New `OAuthDiscoveryState` type and optional `OAuthClientProvider` methods `saveDiscoveryState()` / `discoveryState()` allow providers to persist all discovery results (auth server URL, resource metadata URL, resource metadata, auth server metadata) across sessions. This
      avoids redundant discovery requests and handles browser redirect scenarios where discovery state would otherwise be lost.
    - New `'discovery'` scope for `invalidateCredentials()` to clear cached discovery state.
    - New `OAuthServerInfo` type exported for the return value of `discoverOAuthServerInfo()`.

- [#1673](https://github.com/modelcontextprotocol/typescript-sdk/pull/1673) [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - refactor: extract task
  orchestration from Protocol into TaskManager

    **Breaking changes:**
    - `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`

- [#1763](https://github.com/modelcontextprotocol/typescript-sdk/pull/1763) [`6711ed9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/6711ed9ae8a6a98f415aaa4f145941a562b8e191) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add
  `reconnectionScheduler` option to `StreamableHTTPClientTransport`. Lets non-persistent environments (serverless, mobile, desktop sleep/wake) override the default `setTimeout`-based SSE reconnection scheduling. The scheduler may return a cancel function that is invoked on
  `transport.close()`.

- [#1443](https://github.com/modelcontextprotocol/typescript-sdk/pull/1443) [`4aec5f7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/4aec5f790624b1931cf62c006ae02b09d7562d2f) Thanks [@NSeydoux](https://github.com/NSeydoux)! - The client credentials providers now
  support scopes being added to the token request.

- [#1689](https://github.com/modelcontextprotocol/typescript-sdk/pull/1689) [`0784be1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0784be1a67fb3cc2aba0182d88151264f4ea73c8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Support Standard Schema
  for tool and prompt schemas

    Tool and prompt registration now accepts any schema library that implements the [Standard Schema spec](https://standardschema.dev/): Zod v4, Valibot, ArkType, and others. `RegisteredTool.inputSchema`, `RegisteredTool.outputSchema`, and `RegisteredPrompt.argsSchema` now use
    `StandardSchemaWithJSON` (requires both `~standard.validate` and `~standard.jsonSchema`) instead of the Zod-specific `AnySchema` type.

    **Zod v4 schemas continue to work unchanged** — Zod v4 implements the required interfaces natively.

    ```typescript
    import { type } from 'arktype';

    server.registerTool(
        'greet',
        {
            inputSchema: type({ name: 'string' })
        },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
    );
    ```

    For raw JSON Schema (e.g. TypeBox output), use the new `fromJsonSchema` adapter:

    ```typescript
    import { fromJsonSchema, AjvJsonSchemaValidator } from '@modelcontextprotocol/core';

    server.registerTool(
        'greet',
        {
            inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } }, new AjvJsonSchemaValidator())
        },
        handler
    );
    ```

    **Breaking changes:**
    - `experimental.tasks.getTaskResult()` no longer accepts a `resultSchema` parameter. Returns `GetTaskPayloadResult` (a loose `Result`); cast to the expected type at the call site.
    - Removed unused exports from `@modelcontextprotocol/core`: `SchemaInput`, `schemaToJson`, `parseSchemaAsync`, `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema`. Use the new `standardSchemaToJsonSchema` and `validateStandardSchema` instead.
    - `completable()` remains Zod-specific (it relies on Zod's `.shape` introspection).

- [#1710](https://github.com/modelcontextprotocol/typescript-sdk/pull/1710) [`e563e63`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e563e63bd2b3c2c1d1137406bef3f842c946201e) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `AuthProvider` for
  composable bearer-token auth; transports adapt `OAuthClientProvider` automatically
    - New `AuthProvider` interface: `{ token(): Promise<string | undefined>; onUnauthorized?(ctx): Promise<void> }`. Transports call `token()` before every request and `onUnauthorized()` on 401 (then retry once).
    - Transport `authProvider` option now accepts `AuthProvider | OAuthClientProvider`. OAuth providers are adapted internally via `adaptOAuthProvider()` — no changes needed to existing `OAuthClientProvider` implementations.
    - For simple bearer tokens (API keys, gateway-managed tokens, service accounts): `{ authProvider: { token: async () => myKey } }` — one-line object literal, no class.
    - New `adaptOAuthProvider(provider)` export for explicit adaptation.
    - New `handleOAuthUnauthorized(provider, ctx)` helper — the standard OAuth `onUnauthorized` behavior.
    - New `isOAuthClientProvider()` type guard.
    - New `UnauthorizedContext` type.
    - Exported previously-internal auth helpers for building custom flows: `applyBasicAuth`, `applyPostAuth`, `applyPublicAuth`, `executeTokenRequest`.

    Transports are simplified internally — ~50 lines of inline OAuth orchestration (auth() calls, WWW-Authenticate parsing, circuit-breaker state) moved into the adapter's `onUnauthorized()` implementation. `OAuthClientProvider` itself is unchanged.

- [#1614](https://github.com/modelcontextprotocol/typescript-sdk/pull/1614) [`1a78b01`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1a78b0138f1f3432968e53e810bac7929833eda2) Thanks [@pcarleton](https://github.com/pcarleton)! - Apply resolved scope consistently
  to both DCR and the authorization URL (SEP-835)

    When `scopes_supported` is present in the protected resource metadata (`/.well-known/oauth-protected-resource`), the SDK already uses it as the default scope for the authorization URL. This change applies the same resolved scope to the dynamic client registration request
    body, ensuring both use a consistent value.
    - `registerClient()` now accepts an optional `scope` parameter that overrides `clientMetadata.scope` in the registration body.
    - `auth()` now computes the resolved scope once (WWW-Authenticate → PRM `scopes_supported` → `clientMetadata.scope`) and passes it to both DCR and the authorization request.

### Patch Changes

- [#1758](https://github.com/modelcontextprotocol/typescript-sdk/pull/1758) [`e86b183`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e86b1835ccf213c3799ac19f4111d01816912333) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tasks - disallow requesting
  a null TTL

- [#1824](https://github.com/modelcontextprotocol/typescript-sdk/pull/1824) [`fcde488`](https://github.com/modelcontextprotocol/typescript-sdk/commit/fcde4882276cb0a7d199e47f00120fe13f7f5d47) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Drop `zod` from
  `peerDependencies` (kept as direct dependency)

    Since Standard Schema support landed, `zod` is purely an internal runtime dependency used for protocol message parsing. User-facing schemas (`registerTool`, `registerPrompt`) accept any Standard Schema library. `zod` remains in `dependencies` and auto-installs; users no
    longer need to install it alongside the SDK.

- [#1761](https://github.com/modelcontextprotocol/typescript-sdk/pull/1761) [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Convert remaining
  capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()`, the task capability helpers in `experimental/tasks/helpers.ts`, and the sampling/elicitation capability checks in
  `experimental/tasks/server.ts`.

- [#1632](https://github.com/modelcontextprotocol/typescript-sdk/pull/1632) [`d99f3ee`](https://github.com/modelcontextprotocol/typescript-sdk/commit/d99f3ee5274bb17bb0eb02c85381200feb4b43e6) Thanks [@matantsach](https://github.com/matantsach)! - Continue OAuth metadata discovery
  on 502 (Bad Gateway) responses, matching the existing behavior for 4xx. This fixes MCP servers behind reverse proxies that return 502 for path-aware metadata URLs. Other 5xx errors still throw to avoid retrying against overloaded servers.

- [#1772](https://github.com/modelcontextprotocol/typescript-sdk/pull/1772) [`5276439`](https://github.com/modelcontextprotocol/typescript-sdk/commit/527643966e42a91711c50a0a6609f941f1dfe3e2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Always set
  `windowsHide` when spawning stdio server processes on Windows, not just in Electron environments. Prevents unwanted console windows in non-Electron Windows applications.

- [#1390](https://github.com/modelcontextprotocol/typescript-sdk/pull/1390) [`9bc9abc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9bc9abc68bf2b097b15c76a9673d44fb3ff31d03) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix
  StreamableHTTPClientTransport to handle error responses in SSE streams

- [#1343](https://github.com/modelcontextprotocol/typescript-sdk/pull/1343) [`4b5fdcb`](https://github.com/modelcontextprotocol/typescript-sdk/commit/4b5fdcba02c20f26d8b0f07acc87248288522842) Thanks [@christso](https://github.com/christso)! - Fix OAuth error handling for servers
  returning errors with HTTP 200 status

    Some OAuth servers (e.g., GitHub) return error responses with HTTP 200 status instead of 4xx. The SDK now checks for an `error` field in the JSON response before attempting to parse it as tokens, providing users with meaningful error messages.

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1386](https://github.com/modelcontextprotocol/typescript-sdk/pull/1386) [`00249ce`](https://github.com/modelcontextprotocol/typescript-sdk/commit/00249ce86dac558fb1089aea46d4d6d14e9a56c6) Thanks [@PederHP](https://github.com/PederHP)! - Respect capability negotiation in list
  methods by returning empty lists when server lacks capability

    The Client now returns empty lists instead of sending requests to servers that don't advertise the corresponding capability:
    - `listPrompts()` returns `{ prompts: [] }` if server lacks prompts capability
    - `listResources()` returns `{ resources: [] }` if server lacks resources capability
    - `listResourceTemplates()` returns `{ resourceTemplates: [] }` if server lacks resources capability
    - `listTools()` returns `{ tools: [] }` if server lacks tools capability

    This respects the MCP spec requirement that "Both parties SHOULD respect capability negotiation" and avoids unnecessary server warnings and traffic. The existing `enforceStrictCapabilities` option continues to throw errors when set to `true`.

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1595](https://github.com/modelcontextprotocol/typescript-sdk/pull/1595) [`13a0d34`](https://github.com/modelcontextprotocol/typescript-sdk/commit/13a0d345c0b88bf73264c41a793bf0ad44cfa620) Thanks [@bhosmer-ant](https://github.com/bhosmer-ant)! - Don't swallow fetch `TypeError`
  as CORS in non-browser environments. Network errors (DNS resolution failure, connection refused, invalid URL) in Node.js and Cloudflare Workers now propagate from OAuth discovery instead of being silently misattributed to CORS and returning `undefined`. This surfaces the real
  error to callers rather than masking it as "metadata not found."

- [#1279](https://github.com/modelcontextprotocol/typescript-sdk/pull/1279) [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Initial 2.0.0-alpha.0
  client and server package
