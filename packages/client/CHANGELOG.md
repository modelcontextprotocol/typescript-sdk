# @modelcontextprotocol/client

## 2.0.0-beta.3

### Patch Changes

- [#2456](https://github.com/modelcontextprotocol/typescript-sdk/pull/2456) [`44797d7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/44797d77792953d0ce70b68922bb6bb69e697c32) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Restore the v1 parse tolerance for `CallToolResult.content`: an inbound legacy-era `tools/call` result without `content` defaults to `[]` instead of failing validation. Deployed servers — accepted by SDK v1 for years — return `structuredContent`-only (or otherwise content-less) results, and the strict parse turned every such call into an `INVALID_RESULT` error before application code could run.

    The silent-empty-success hazard the strictness guarded is preserved where it matters: the 2025 era's wire-seam schema refuses to default `content` for a body carrying another result family's vocabulary (`task`, `inputRequests`, `requestState` — the era is frozen, so the list is complete), and the 2026-era wire schemas stay strict — modern-revision servers have no legacy excuse. Task interop through an explicit result schema is untouched (including bodies that also stamp a foreign `resultType`), and the server-side authoring normalization refuses the same foreign-family vocabulary.

    Server-side authoring is era-independent: a handler result without `content` (dynamic/JS callers — the TypeScript surface requires it) is normalized to `content: []` before era validation on every leg, reaching the wire spec-valid.

    Conscious call: the nested sampling `ToolResultContentSchema` stays spec-strict — v1 had defaulted its `content` too, but it is params-side (tool results a caller authors into a sampling message), deliberately not restored.

- [#2431](https://github.com/modelcontextprotocol/typescript-sdk/pull/2431) [`1b90c96`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b90c96d11fd17016d2977cae9dd661de3fb84df) Thanks [@morluto](https://github.com/morluto)! - Fix the CommonJS `validators/ajv` subpath so reading the exported `Ajv` class no longer throws `ReferenceError: import_ajv is not defined`. The subpath now re-exports the bundled provider's concrete `Ajv` value in CJS output, matching the existing ESM behavior.

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

- [#2384](https://github.com/modelcontextprotocol/typescript-sdk/pull/2384) [`ce2f65d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/ce2f65db0e019506f4d2526466ec8cc7106de98e) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `instanceof` on the SDK error classes (`ProtocolError` and its typed subclasses, `SdkError`/`SdkHttpError`, `OAuthError`, and the client's `SseError`, `UnauthorizedError`, and OAuth-client-flow error family — `OAuthClientFlowError` and its subclasses) now works across separately bundled copies of the SDK. The classes match by a stable brand (via `Symbol.hasInstance` and a registry symbol) instead of prototype identity, so a process that uses both `@modelcontextprotocol/client` and `@modelcontextprotocol/server` - a gateway, host, or in-process test - can check errors constructed by either package against the class re-exported by the other. Ordinary prototype-based `instanceof` is preserved as a fallback; user-defined subclasses keep plain prototype semantics. Notes: cross-bundle matching requires both copies to be at or after this release; brands assert identity, not field shape, across versions - keep reading fields defensively. As a side effect, a foreign-bundle `SdkError` used as an abort reason is now rethrown as-is instead of being wrapped as a `RequestTimeout`. Branded hierarchies additionally expose an explicit static guard, `X.isInstance(value)`, that reads the same brand and narrows in TypeScript — an alternative for codebases that prefer predicate-style checks over `instanceof`. Also: `UnauthorizedError` now sets `error.name` to `'UnauthorizedError'` (previously `'Error'`), and per-package conformance tests enforce that every exported error class participates in branding. Version-negotiation probing now recognizes `UnauthorizedError` (previously a dead name-string check) and propagates it unchanged, so `connect()` on an auth-gated server rejects with the original `UnauthorizedError` (previously wrapped as the `cause` of an `SdkError(EraNegotiationFailed)`) — run `finishAuth()` and reconnect, and the retry probes with the token.

- [#2469](https://github.com/modelcontextprotocol/typescript-sdk/pull/2469) [`9b41b56`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9b41b5685ded29c0afc194bbd91bb1902bee6f84) Thanks [@felixweinberger](https://github.com/felixweinberger)! - The Streamable HTTP client transport no longer attaches a session ID to a POST containing an `initialize` request — a new session starts "without a session ID attached" (2025-11-25 transports §Session Management) — and it only captures the `mcp-session-id` response header from a successful initialize response, since the spec assigns the session ID "at initialization time … on the HTTP response containing the InitializeResult". Previously the transport stored the header from any response, so a legacy server answering a protocol-version probe with an error that happened to carry a session ID would poison the fallback initialize, which then went out with a session ID it should not have had. A stale session ID from a previous connection is likewise no longer leaked onto the initialize handshake, and a successful initialize response that carries no session ID now clears any stale ID the transport was holding — clients include only an ID "returned by the server during initialization", so an ID the server never returned this session is outside the session model. Ignoring `mcp-session-id` headers mid-session is the complement of the spec's one actual rotation mechanism: a server that wants a new session terminates the old one (it "MAY terminate the session at any time") and answers 404, after which the client "MUST start a new session by sending a new InitializeRequest without a session ID attached". Rotation exists as session replacement via 404 + re-initialize, never as a header swap on a live session, so a server that rotates per the spec's own flow is handled correctly by this transport.

- [#2455](https://github.com/modelcontextprotocol/typescript-sdk/pull/2455) [`cc70c5e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/cc70c5e6a9f9b1c15dcba0bdd019a479b81375de) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Version negotiation no longer discards transport handlers the caller set before `connect()`. The probe window now saves any pre-set `onmessage`/`onerror`/`onclose`, forwards error and close events to them while the probe is in flight, and restores them when the window closes — so `Protocol.connect()` chains them exactly as it does on a plain connect. Previously, connecting with `versionNegotiation` silently cleared pre-set handlers (e.g. an `onerror` used to detect session-expiry auth failures), leaving them permanently detached for the life of the connection.

- [#2425](https://github.com/modelcontextprotocol/typescript-sdk/pull/2425) [`e8de519`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e8de519d3129f46b7528d2999b7641f55be1f091) Thanks [@Sehlani042](https://github.com/Sehlani042)! - Stop advertising validator provider classes from the root client/server type declarations. The provider classes remain available from the explicit validator subpaths.

## 2.0.0-beta.2

### Patch Changes

- [#2405](https://github.com/modelcontextprotocol/typescript-sdk/pull/2405) [`f172626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f172626a8e98b2ae2f0f690e4afb4dc74dbf6011) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Ship CommonJS builds alongside ESM. Each package now emits both `.mjs`/`.d.mts`
  and `.cjs`/`.d.cts` (via tsdown `format: ['esm', 'cjs']`), and its `exports` map
  adds a `require` condition so `require('@modelcontextprotocol/…')` works from
  CommonJS consumers. Output extensions are normalized across all packages
  (`@modelcontextprotocol/core` moves from `.js`/`.d.ts` to `.mjs`/`.d.mts`); the
  public import paths are unchanged.

## 2.0.0-beta.1

### Patch Changes

- [#2402](https://github.com/modelcontextprotocol/typescript-sdk/pull/2402) [`a400259`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a4002596b914c675d17ac22471d1287976dbb52a) Thanks [@felixweinberger](https://github.com/felixweinberger)! - First beta release of SDK v2 with support for the MCP 2026-07-28 specification
  revision. See the migration guides for upgrading from v1
  (`docs/migration/upgrade-to-v2.md`) and adopting the 2026-07-28 revision
  (`docs/migration/support-2026-07-28.md`).

## 2.0.0-alpha.4

### Major Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `Client.listTools()` / `listPrompts()` / `listResources()` / `listResourceTemplates()` now **auto-aggregate every page** when called without a `cursor` and return the complete result with `nextCursor: undefined` (matching the C#, Java, and mcp.d SDKs). Pass an explicit `{ cursor }` string to fetch a single page; the per-page path is unchanged. Existing manual pagination loops keep working — the first iteration returns everything and the loop exits — but can be deleted. The aggregated result is written to the new pluggable `ResponseCacheStore` (default: a fresh per-instance `InMemoryResponseCacheStore`); a `ClientResponseCache` collaborator owns the eviction-generation guard and the derived `tools/list` index that `callTool`'s output validation and SEP-2243 `Mcp-Param-*` mirroring read. New exports: `ResponseCacheStore`, `CacheKey`, `CacheEntry`, `CacheScope`, `MaybePromise`, `InMemoryResponseCacheStore`; new `ClientOptions.responseCacheStore` / `ClientOptions.listMaxPages` (caps the auto-aggregate walk at 64 pages by default; throws `SdkError` with `SdkErrorCode.ListPaginationExceeded` on overrun so a partial aggregate is never cached). The store interface is async-ready (`MaybePromise<…>`); the in-memory default stays synchronous. Entries are automatically scoped by the connected server's identity and (when set) the consumer-supplied `cachePartition`, so a shared store does not collide across servers or principals; evictions are likewise scoped to the connected server's partitions.

    **Behavior change (every era):** output-schema validator compilation is now lazy — validators are compiled on the first `callTool()` against the cached `tools/list` entry, not eagerly inside `listTools()`. `listTools()` no longer throws on an uncompilable `outputSchema` (every tool stays listed; the compile failure is captured per-tool); calling `callTool()` on the affected tool throws `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")` before the request is sent — output-schema validation is never silently skipped. A pluggable `jsonSchemaValidator` provider therefore observes compilation at `callTool` time, not `listTools` time. The legacy-era `listTools()` path is unchanged at the wire level but is observably different at the validator-lifecycle level.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Split the wire layer into per-era codecs and make protocol-revision deletions physical. Deliberate wire/schema behavior changes (see docs/migration/support-2026-07-28.md "Per-era wire codecs"):
    - `resultType` is no longer modeled by any neutral wire schema: `EmptyResultSchema` (strict) now rejects `{resultType}` bodies; on 2025-era connections a foreign `resultType` is stripped before validation instead of rejected; the member exists only inside the 2026-era codec, which requires it.
    - `CallToolResult.content` / `ToolResultContent.content` are required at the wire boundary (`content.default([])` removed): handler results without `content` are rejected with `-32602` instead of silently defaulted, and content-less wire results fail the client parse loudly.
    - Custom (3-arg) handlers now receive `_meta` minus the reserved envelope keys instead of having it deleted before params validation.
    - `specTypeSchemas` re-scoped to the neutral model: result validators no longer accept `resultType`; task message-type validators and `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed).
    - Role aggregate types/schemas (`ClientRequest`, `ServerResult`, …) no longer carry task vocabulary; the deprecated `Task*` types remain importable unchanged.
    - Era-mismatched spec methods fail physically: inbound era-deleted methods get `-32601` even with a handler registered; outbound sends throw `SdkErrorCode.MethodNotSupportedByProtocolVersion` locally.
    - Value guards (`isCallToolResult`, …) are documented as neutral-shape consumer checks, not wire validators.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Hide wire-only protocol members from the public surface, at the type level and at runtime. `resultType` (the 2026-07-28 result discrimination field) is no longer declared on any public result type — the wire schemas keep parsing it, and the client funnel now consumes it raw-first: `'complete'` results are stripped to the public shape and any other kind (e.g. `input_required`) rejects with the new `SdkErrorCode.UnsupportedResultType` instead of masking into an empty success. The reserved `_meta` envelope keys are lifted out of inbound requests and notifications before handlers run, and the multi-round-trip retry fields (`inputResponses`, `requestState`) out of inbound requests only (the spec reserves those names on client-initiated requests; notification params keep them), so handler params keep the 2025-era shape; for requests the lifted material surfaces at `ctx.mcpReq.envelope`, `ctx.mcpReq.inputResponses`, and `ctx.mcpReq.requestState` (notifications have no ctx — their lifted envelope keys are not surfaced). High-level client/server methods now return the named public result types (`Promise<CallToolResult>` etc.). Task wire vocabulary stays importable but is `@deprecated` and excluded from the typed method maps (`RequestMethod`/`RequestTypeMap`/`ResultTypeMap`/`NotificationTypeMap`), and `callTool` is typed as plain `CallToolResult`. See docs/migration/support-2026-07-28.md "Wire-only members hidden from public types".

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-1613 / SEP-2106 (JSON Schema 2020-12 posture): the Node default JSON Schema validator is now `Ajv2020` (true draft 2020-12) instead of the draft-07 `Ajv` class — `$defs`/`prefixItems`/`unevaluatedProperties`/`dependentRequired` are now enforced where they were previously silently ignored; to opt back, construct the draft-07 instance with the v1 defaults — `const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }); addFormats(ajv);` — and pass `new AjvJsonSchemaValidator(ajv)`. Schemas declaring a `$schema` other than 2020-12 are rejected with a clear error rather than mis-validating. `outputSchema` may now have a non-object root and `CallToolResult.structuredContent` is widened to `unknown` (a deliberate source-level break for typed consumers — see the migration guide for the narrowing pattern). Toward 2025-era clients McpServer wraps a non-object `outputSchema` (and the matching `structuredContent`) in a `{result: …}` envelope so the tool stays callable, with same-document `$ref`/`$dynamicRef` pointers rewritten to keep resolving — low-level `Server` users (those bypassing `McpServer` and registering a `tools/call` handler directly) get the same wrap by routing the result through the new `Server.projectCallToolResult(result, advertisedOutputSchema)`. Independently, on every era (the SEP's MUST applies regardless of client version), McpServer auto-appends a `TextContent` JSON serialisation when a handler returns non-object `structuredContent` without its own text block. The `structuredContent` presence check is `!== undefined` (not falsy) on both sides. Thanks @mattzcarey (#2249).

### Minor Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `connect(transport, { prior: DiscoverResult })` for zero-round-trip reconnect (the gateway / distributed-client pattern). Supplying a previously-obtained `DiscoverResult` skips the `server/discover` probe: on a 2026-era server `connect()` sends nothing on the wire and `callTool()` etc. work immediately. Pair with the new `client.getDiscoverResult()` (populated by the `'auto'`-mode probe, by `client.discover()`, and by `connect({ prior })` itself) — the value round-trips through `JSON.stringify`, so a gateway can probe once, persist the blob, and feed it to every worker. Only reuse a persisted `DiscoverResult` across clients that present the same authorization context as the client that obtained it.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add opt-in protocol version negotiation on `ClientOptions.versionNegotiation`. The default is unchanged: without the option (or with `mode: 'legacy'`) the client performs today's 2025 connect sequence byte-identically. `mode: 'auto'` probes the server with `server/discover` at
  connect time and conservatively falls back to the plain legacy `initialize` handshake on the same connection unless the outcome is definitive modern evidence (with a supported-versions list that has no 2025-era entry there is nothing to fall back to, and connect rejects
  with a typed error instead); a network outage rejects with a typed connect error, and a probe timeout is transport-aware — on stdio it indicates
  a legacy server and falls back to `initialize` on the same stream, on HTTP it rejects with a typed timeout error.
  `mode: { pin: '<version>' }` negotiates exactly the pinned modern revision with no fallback. Probe policy lives under `probe: { timeoutMs? }` — the probe inherits the standard request timeout. The probe's `MCP-Protocol-Version`/`Mcp-Method` headers derive from the probe
  message body; the transport version slot is never touched during negotiation, so legacy-era traffic carries zero 2026 headers by construction. Adds the `SdkErrorCode.EraNegotiationFailed` code for negotiation-phase connect failures.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Dynamic Client Registration hygiene for the 2026-07-28 authorization requirements (SEP-837, SEP-2207). New `resolveClientMetadata(provider)` reads `provider.clientMetadata` and applies the spec defaults — `application_type` derived from the redirect URIs (loopback or custom scheme → `'native'`, otherwise `'web'`), `grant_types: ['authorization_code', 'refresh_token']` when omitted — and `auth()` feeds the resolved document to DCR only (scope selection still reads the raw consumer-supplied `clientMetadata` so statically-registered/CIMD clients are not pushed into `offline_access` + `prompt=consent`); consumer-set values are never overwritten. DCR rejection now throws the new `RegistrationRejectedError` carrying the HTTP status, raw body, and submitted metadata — **breaking for direct `registerClient()` callers**: rejection no longer throws `OAuthError`, so update `instanceof` checks. `OAuthClientMetadata` gains a typed `application_type?: string` field (expected `'native'` / `'web'`; tolerant on parse). `OAuthErrorCode` adds `InvalidRedirectUri`. The token-exchange, refresh, and Cross-App Access (`requestJwtAuthorizationGrant` / `exchangeJwtAuthGrant`) paths now throw the new `InsecureTokenEndpointError` for a non-`https:` token endpoint (`localhost` / `127.0.0.1` / `::1` exempt), and `auth()` surfaces it on the refresh branch instead of silently re-authorizing.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2468 follow-up: `transport.finishAuth()` gains a `URLSearchParams` overload (preferred) that extracts `code`/`iss`, validates `iss` first, and on mismatch throws a sanitized `IssuerMismatchError` (no callback `error_description` text); callers remain responsible for `state`. **Behavior change for `@modelcontextprotocol/server-legacy`:** `mcpAuthRouter` now advertises `authorization_response_iss_parameter_supported` (default `true`; `ProxyOAuthServerProvider` reports `false`) and the bundled authorize handler appends `iss` (RFC 9207) to every `res.redirect(...)` your `OAuthServerProvider.authorize()` issues to the client's `redirect_uri`. If your provider redirects another way (`res.writeHead`, a separate consent-page response, or a standalone `authorizationHandler({provider})` without `issuerUrl`), append `params.issuer` as `iss` yourself or set `authorizationResponseIssParameterSupported: false` — otherwise RFC 9207-compliant clients (including this SDK) will reject the callback.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Implement RFC 9207 / RFC 8414 §3.3 OAuth issuer validation (SEP-2468). `discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not match the discovery URL (opt out via `skipIssuerValidation` / `AuthOptions.skipIssuerMetadataValidation` — security-weakening). `auth()`, `exchangeAuthorization()`, `fetchToken()`, and `transport.finishAuth(code, iss?)` now validate the authorization-callback `iss` against the recorded issuer before redeeming the code; new `IssuerMismatchError` and `validateAuthorizationResponseIssuer()` are exported.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Per-authorization-server credential isolation (SEP-2352). `auth()` now stamps an `issuer` field onto every value it passes to `saveTokens()` / `saveClientInformation()` and threads `{ issuer }` to `tokens()` / `clientInformation()`; on read, a stored credential whose stamp names a different authorization server is treated as `undefined`, so a `client_id` / `refresh_token` issued by one AS is never sent to another. Providers that round-trip stored values verbatim are protected with no code change; multi-AS providers may key storage on `ctx.issuer`. New `AuthorizationServerMismatchError` (callback-leg gate). `OAuthClientProvider.saveAuthorizationServerUrl()` / `authorizationServerUrl()` are deprecated (still written, never read). `ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`, and `CrossAppAccessProvider` gain `expectedIssuer` and no longer define `saveClientInformation()`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the public surface for the 2026-07-28 authorization requirements. New `AuthOptions` type names the `auth()` options object and adds `iss` and `skipIssuerMetadataValidation` fields. `OAuthClientProvider.clientInformation()` / `.saveClientInformation()` / `.tokens()` / `.saveTokens()` accept an optional `OAuthClientInformationContext` carrying the authorization server's `issuer` so providers can key persisted credentials per authorization server. New `StoredOAuthTokens` / `StoredOAuthClientInformation` aliases add an `issuer` stamp field on top of the wire types (kept off the wire schemas so an authorization server cannot populate it) and become the parameter/return types of the credential methods. New `OAuthClientFlowError` base class in `authErrors.ts` for the flow-specific error classes that follow. All changes are additive — existing `OAuthClientProvider` implementations compile unchanged; the new fields are inert until the behavior changes that follow wire them up.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `Client` now **honours** the server-stamped SEP-2549 `ttlMs`/`cacheScope` cache hints on the cacheable verbs (`listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()`, `readResource()`): a still-fresh held entry is served without a round trip. New `CacheableRequestOptions.cacheMode` (`'use'` — the default; `'refresh'` — always fetch and re-store; `'bypass'` — fetch without consulting or writing the cache) gives per-call control. The behaviour is opt-in by hint: a server that sends `ttlMs: 0` (the conservative default this SDK's server stamps) sees byte-identical behaviour — every call fetches.

    Entries are automatically scoped by connected-server identity (derived from `serverInfo` after connect, encoded collision-free via `JSON.stringify`); `ClientOptions.cachePartition` is the opaque per-principal slot for `'private'`-scoped entries — set it to your principal identifier (e.g. the auth subject) when one `responseCacheStore` backs several principals. With the default `''` every entry lives at the connected server's shared partition (the safe single-tenant posture). `ClientOptions.defaultCacheTtlMs` (default `0`) supplies the TTL when a result lacks one (e.g. a legacy-era response); the server-supplied `ttlMs` is clamped at 24 h (`MAX_CACHE_TTL_MS`). The list verbs always store the aggregate (so `callTool`'s mirroring/output-validation index keeps working at any TTL); `readResource` stores only when the resolved TTL is positive. `notifications/resources/updated` evicts the cached `resources/read` body for that URI. `ResponseCacheStore` gained `delete(key)`; `InMemoryResponseCacheStore` is now bounded (`{ maxEntries }`, default 512, oldest-first eviction). New exports: `CacheMode`, `CacheableRequestOptions`, `InMemoryResponseCacheStoreOptions`, `MAX_CACHE_TTL_MS`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Client request cancellation on a 2026-07-28 Streamable HTTP connection now closes that request's SSE response stream — the spec cancellation signal — instead of POSTing `notifications/cancelled`. Cancellation on a 2025-era connection, and on stdio at any era, still sends `notifications/cancelled` as before. Adds the optional `Transport.hasPerRequestStream` capability flag (set on `StreamableHTTPClientTransport`) for the protocol layer to route the per-transport cancel path.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `SdkErrorCode.MethodNotSupportedByProtocolVersion`: a typed local error raised before anything reaches the transport when a spec method is sent toward a peer whose negotiated protocol version's wire era does not define it (for example `tasks/get` toward a 2026-07-28 peer). The protocol layer now resolves a per-era wire codec from the connection's negotiated protocol version (instance state on `Client`/`Server`, with the legacy era as the pre-negotiation default) and resolves per-method schemas at dispatch time instead of registration time; an edge classification on an inbound message is validated against that instance era, and a mismatch is rejected as an entry/routing error. Behavior on existing (2025-era) connections is unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Per-request `_meta` envelope auto-emission on modern-era connections: once a client negotiates a 2026-07-28+ protocol revision (via `versionNegotiation: { mode: 'auto' }` or `{ pin }`), it automatically attaches the reserved protocol-version / client-info / client-capabilities
  `_meta` keys to every outgoing request and notification — you no longer set the envelope by hand. User-supplied `_meta` keys take precedence over the auto-attached ones; the auto-attached client-capabilities reflect what the client actually registered. Legacy-era connections
  (the default, and the `'auto'`-mode fallback) never gain these keys, so 2025-era outbound traffic is byte-identical to before.

    Adds `Client.getProtocolEra()` (`'legacy' | 'modern' | undefined`), the `ProtocolEra` type, `Client.setVersionNegotiation()` for configuring negotiation pre-connect on an already-constructed instance, and the `probe.maxRetries` knob (default `0`) which governs probe-timeout
    re-sends only — the spec-mandated `-32022` corrective continuation is never counted against it. The `versionNegotiation` default remains `'legacy'`: absent (or `mode: 'legacy'`), `connect()` runs the plain 2025 sequence, byte-identical to a v1.x client.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `MissingRequiredClientCapabilityError`, the typed error class for the 2026-07-28 `-32021` protocol error (processing a request requires a capability the client did not declare). Its `data.requiredCapabilities` lists the missing capabilities and `ProtocolError.fromError` recognizes the code/data shape. The 2026-07-28 HTTP entry gains a pre-dispatch gate that refuses a request requiring an undeclared client capability with this error and HTTP status `400`; no method served on the 2026-07-28 registry currently carries such a requirement, so observable behavior is unchanged until methods with capability requirements exist.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the client side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). The neutral `InputRequest`/`InputResponse`/`InputRequests`/`InputResponses`/`InputRequiredResult` types and the `isInputRequiredResult()` guard ship as the neutral surface (the
  `inputRequired()` builder family and the `acceptedContent()` reader are exported by the server package as part of the server-side change); the 2026-07-28 wire codec models the in-band vocabulary (embedded requests and bare responses) and the retry-channel request fields. On the
  client, an `input_required` answer to `tools/call`, `prompts/get`, or `resources/read` on a 2026-07-28 connection is now fulfilled automatically by default: the embedded requests are dispatched to the client's already-registered elicitation/sampling/roots handlers, and the
  original call is retried with the collected `inputResponses`, a byte-exact echo of the opaque `requestState`, and a fresh request id, up to `inputRequired.maxRounds` rounds (default 10; exhaustion raises a typed `InputRequiredRoundsExceeded` error carrying the last result).
  `client.callTool()` and its siblings keep returning their plain result types. `ClientOptions.inputRequired` (`autoFulfill`, `maxRounds`) configures the driver; manual mode is `autoFulfill: false` plus the per-call `allowInputRequired: true` request option and the
  `withInputRequired()` schema wrapper. Retried requests surface their `inputResponses` to server handlers as bare response objects — entries in a wrapped `{method, result}` shape are dropped and reported via `ctx.mcpReq.droppedInputResponseKeys`. 2025-era behavior is unchanged:
  the legacy wire has no `input_required` vocabulary and the legacy server-to-client request flow is untouched.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `resources/read` for an unknown URI now answers with JSON-RPC error code `-32602`
  (Invalid Params) on every protocol revision, with `error.data.uri` echoing the
  requested URI. The 2026-07-28 specification requires `-32602`; the v1.x SDK already
  emitted `-32602` on earlier revisions, so v1.x peers see no change.

    This supersedes an interim `-32002` emission that shipped in earlier v2 alphas. The
    era-aware encode seam (`WireCodec.encodeErrorCode`) maps any handler-thrown `-32002`
    to `-32602` on the wire; note that a `-32002` thrown without `data.uri` is emitted as
    a bare `-32602` and is no longer recognizable as resource-not-found — throw
    `ResourceNotFoundError` (or include `data: { uri }`) to preserve the classification.

    `ProtocolErrorCode.ResourceNotFound` (`-32002`) remains importable as receive-tolerated
    vocabulary; clients should accept both `-32602` and `-32002` from peers (the
    specification's backwards-compatibility clause). The new typed `ResourceNotFoundError`
    class carries `data.uri`, and `ProtocolError.fromError` reconstructs it from a `-32602`
    only when `error.data` is exactly `{ uri: string }` (and nothing else), and from a
    legacy `-32002` whenever `data.uri` is a string; a bare `-32002` without `data.uri`
    stays a generic `ProtocolError`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2243 `Mcp-Param-*` client-side mirroring (protocol revision 2026-07-28). On a 2026-07-28 connection over Streamable HTTP, `Client.callTool()` now mirrors tool arguments designated with `x-mcp-header` in the tool's `inputSchema` into `Mcp-Param-{Name}` HTTP headers (with the spec's `=?base64?…?=` sentinel encoding for values that are not safe plain-ASCII field values), and on a non-stdio modern connection `Client.listTools()` (and the client's internal `tools/list` cache) exclude tool definitions whose `x-mcp-header` declarations violate the spec's constraints, logging a warning naming the tool and the reason. The legacy-era `callTool` and `listTools` paths are unchanged at the wire level. Browser environments skip mirroring (dynamically named headers cannot be statically allow-listed for credentialed CORS); a conforming SEP-2243 server will reject a `tools/call` whose body carries a non-null value for an `x-mcp-header` parameter when the matching header is absent, so calling such a tool with that argument from a browser is a known limitation. New `CallToolRequestOptions.toolDefinition` lets callers supply the tool definition directly so mirroring and output-schema validation can run without a prior `tools/list`. `TransportSendOptions.headers` is added (additive, optional) for per-request HTTP headers; the Streamable HTTP transport skips reserved standard/auth header names (`authorization`, `mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-session-id`, `content-type`); transports that share a single channel (stdio, in-memory) ignore it.

    The Streamable HTTP transport now emits the `Mcp-Name` standard header on every modern-enveloped request (`params.name` for `tools/call`/`prompts/get`, `params.uri` for `resources/read`), sentinel-encoded.

    **Behavior change (modern era only):** on a modern-enveloped request the Streamable HTTP transport now surfaces an HTTP `400` whose body is a well-formed JSON-RPC error response addressed to the pending request id in-band as a `ProtocolError` (instead of `SdkHttpError`), so the `HEADER_MISMATCH` recovery retry can fire. Legacy-era exchanges are unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2350 scope step-up: on `403 insufficient_scope`, `StreamableHTTPClientTransport` now re-authorizes with the **union** of the previously-requested and challenged scopes (`computeScopeUnion`), bypassing the refresh-token branch when the union is a strict superset of the current token's granted scope (`isStrictScopeSuperset`, `AuthOptions.forceReauthorization`). New `onInsufficientScope: 'reauthorize' | 'throw'` (default `'reauthorize'`) and `maxStepUpRetries` (default 1) on `StreamableHTTPClientTransportOptions`; `'throw'` raises the new `InsufficientScopeError`. The GET listen-stream open path now applies the same step-up handling. The previous verbatim-header retry guard is replaced by the bounded per-send counter.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Align the 2026-07-28 protocol error codes to the spec renumber: `HeaderMismatch` is now `-32020` (was `-32001`), `MissingRequiredClientCapability` is now `-32021` (was `-32003`), and `UnsupportedProtocolVersion` is now `-32022` (was `-32004`). These codes are part of the draft 2026-07-28 protocol revision only and have never appeared on a 2025-era wire — the 2025 serving paths and the SDK-conventional `-32001` (`Session not found`) on the stateful Streamable HTTP transport are unchanged. `ProtocolErrorCode.MissingRequiredClientCapability`, `ProtocolErrorCode.UnsupportedProtocolVersion`, the `HEADER_MISMATCH_ERROR_CODE` constant, and the `HEADER_MISMATCH` / `MISSING_REQUIRED_CLIENT_CAPABILITY` / `UNSUPPORTED_PROTOCOL_VERSION` spec-type constants now carry the renumbered values; the `UnsupportedProtocolVersionError` and `MissingRequiredClientCapabilityError` classes (and `ProtocolError.fromError` recognition) follow. The client probe classifier recognizes `-32022` for the corrective continuation and the SEP-2243 one-refresh-on-miss retry triggers on `-32020`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `Client.listen(filter)` opens a `subscriptions/listen` stream on a 2026-07-28-era connection, resolving once the server's acknowledged notification arrives with an `McpSubscription { honoredFilter, close(), closed }`. `closed` is a `Promise<'local' | 'remote'>` that resolves exactly once when the subscription terminates (`'local'` = you called `close()`; `'remote'` = the server cancelled, the stream ended, or the transport dropped — re-listen if you still want events) and never rejects. Change notifications delivered on the stream dispatch to the existing `setNotificationHandler` registrations — the same handlers the 2025-era unsolicited notifications fire on a legacy connection — so `listen()` is era-transparent for consumers that already register those. `close()` aborts the listen request's stream (where the transport supports it) and sends `notifications/cancelled` referencing the listen id — both, on every transport; no automatic re-listen. On a 2025-era connection `listen()` throws a typed `MethodNotSupportedByProtocolVersion` steering to `resources/subscribe` and `ClientOptions.listChanged`. `ClientOptions.listChanged` now auto-opens a listen stream on a modern connection — the filter is the intersection of the configured sub-options and the server-advertised `listChanged` capabilities; auto-open is skipped (`client.autoOpenedSubscription` stays `undefined`) when that intersection is empty; otherwise the auto-opened subscription is exposed at `client.autoOpenedSubscription`. `TransportSendOptions` gains `requestSignal` (per-request abort) and `onRequestStreamEnd` (fires when a per-request response stream ends or errors for any non-deliberate reason) on the Streamable HTTP transport.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `subscriptions/listen` graceful close: per spec PR #2953, a server-side graceful close (`createMcpHandler` / `serveStdio` `close()`) now emits the empty `subscriptions/listen` JSON-RPC result (the new `SubscriptionsListenResult` — `_meta` carries the subscriptionId) before closing the stream, replacing the previous server-originated `notifications/cancelled`. On the client, `McpSubscription.closed` now resolves `'graceful'` for this signal (added alongside `'local'` and `'remote'`); a stream close without a result remains `'remote'` (unexpected disconnect).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Wire `server/discover` (protocol revision 2026-07-28) into the typed request funnel and serve it era-aware. The request joins `ClientRequestSchema`/`ServerResultSchema`/`ResultTypeMap` (per-era availability stays with the wire registries: only the 2026-era registry serves
  it), and `Client.discover()` issues it as a typed request on 2026-era connections. A `Server` whose `supportedProtocolVersions` list carries a modern (2026-07-28+) revision installs the `server/discover` handler, advertising ONLY its modern revisions and excluding the
  listChanged/subscribe-class capabilities until the `subscriptions/listen` flow ships; servers with today's default list are unchanged and keep answering `-32601`. The `initialize` handshake is now era-aware in the other direction: its accept check and counter-offer consult
  only the legacy subset of the supported versions — a 2026-era revision is never negotiated via `initialize` — so a 2025-era client can never be offered a 2026 version string; with the default list this is byte-identical to previous behavior. Serving the 2026 revision to
  ordinary HTTP/stdio traffic arrives with an upcoming server-side entry point: today the negotiation surface is client-side, and `mode: 'auto'` falls back cleanly against current SDK servers.

### Patch Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Drop inbound JSON-RPC requests on connections that negotiated the 2026-07-28 draft revision instead of answering them: the modern era has no server→client request channel (server-initiated interactions are carried in `input_required` results), and the stdio transport forbids the
  client from writing JSON-RPC responses. Dropped requests are surfaced via `onerror`. Legacy-era connections, responses, and notifications are unchanged.

- [#2394](https://github.com/modelcontextprotocol/typescript-sdk/pull/2394) [`801111e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/801111ea152c1ba08f6dda0b27d712759aeb46bf) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fix the published declaration files for consumers compiling with `skipLibCheck: false`: the bundled `.d.mts` no longer leaves a dangling `URIComponent` reference (ajv's published types import it from `fast-uri`, whose export-assigned namespace the dts bundler cannot link — the type is now inlined via a dts-only path mapping), and no longer imports `json-schema-typed` from an undeclared dependency (it is inlined via `dts.resolve`). `@modelcontextprotocol/node` and `@modelcontextprotocol/server` drop stale `typesVersions` entries pointing at subpaths that never shipped. Package READMEs note that TypeScript >=6.0 requires `"types": ["node"]` since the published declarations reference `Buffer`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Complete the SEP-2577 `@deprecated` sweep on the public type surface (SEP-2596 Tier-1 obligation). Marks the full Logging type stack (`LoggingLevel`, `SetLevelRequest`, `LoggingMessageNotification` and params), the full Sampling type stack (`CreateMessageRequest`/`Result`, `SamplingMessage`, `ModelPreferences`/`ModelHint`, `ToolChoice`, `ToolUseContent`/`ToolResultContent`, and the `includeContext` enum values), the full Roots type stack (`Root`, `ListRootsRequest`/`Result`, `RootsListChangedNotification`), and `registerClient` (Dynamic Client Registration; prefer Client ID Metadata Documents per SEP-991). Mirrors the markers already present on the per-revision reference types. JSDoc only — wire behavior is unchanged; everything remains fully functional during the deprecation window (at least twelve months).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Re-pin the 2026-07-28 draft references (spec reference types, vendored schema.json twins, example corpus) to the latest spec commit and align the 2026-era wire surface with it. Deliberate 2026-era wire behavior changes (the released 2025-11-25 surface is untouched):
    - `notifications/elicitation/complete` is no longer part of the 2026-07-28 wire registry (the draft removed the notification together with `elicitationId` on URL-mode elicitation). On connections negotiated at 2026-07-28, sending it — including via `Server.createElicitationCompletionNotifier()` — now fails locally with `SdkErrorCode.MethodNotSupportedByProtocolVersion`, and inbound copies are dropped as unknown notifications. Both remain fully supported on 2025-11-25.
    - `notifications/cancelled` on 2026-era connections now parses with a revision-exact schema that requires `requestId` (the draft made it required); the notification `_meta` shape types the `io.modelcontextprotocol/subscriptionId` key. 2025-era parsing is unchanged.
    - The error code `-32001` emitted for HTTP header/body mismatches is now defined by the draft schema (`HEADER_MISMATCH`); the emitted behavior is unchanged (documentation only).

    No public API surface changes; the regenerated reference artifacts are internal/test-only.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Internal: regenerate the 2026-07-28 spec reference types from the latest draft schema (`DiscoverResult` now extends `CacheableResult`; `ElicitationCompleteNotificationParams` extracted as a named interface) and document the anchor lifecycle policy. Released-revision spec-type generation is now pinned to a fixed spec commit; draft anchors keep floating via the nightly refresh PRs. No public API or runtime behavior changes.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Freeze the per-era wire schemas as self-contained copies decoupled from the public types layer, and convert `WireCodec` to a function-only interface. Two small spec-conformance fixes ride along with the otherwise-pure refactor:
    - The 2026 wire-true `resultType` member now defaults to `'complete'` when absent (the spec's receiver-side back-compat rule); the inbound `decodeResult` step continues to require it. The `server/discover` result accepts absent or malformed `ttlMs`/`cacheScope` (falling back to `0`/`'private'` per the spec's receiver leniency in caching.mdx) so the version-negotiation probe classifier stays behavior-neutral. Other cacheable result schemas are unchanged here; general receiver leniency for those belongs to the response-cache surface.
    - The sampling `hasTools` discriminant now keys on `tools || toolChoice` (previously `tools` only), aligning the client and server selection of the with-tools result variant with `clientCapabilityRequirements`.

## 2.0.0-alpha.3

### Major Changes

- [#2128](https://github.com/modelcontextprotocol/typescript-sdk/pull/2128) [`c8d7401`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c8d7401b46f34b6c49b7cfb7b321714d0d4048f6) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2663: remove
  2025-11 experimental tasks (TaskManager, experimental.tasks.\* accessors). Tasks are now Extensions Track.

### Minor Changes

- [#2049](https://github.com/modelcontextprotocol/typescript-sdk/pull/2049) [`4f226c1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/4f226c1e35200616d62f1d7e46a2daa33d91172a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add `SdkHttpError` subclass
  with typed `.status` / `.statusText` accessors for HTTP transport failures. `StreamableHTTPClientTransport` now throws `SdkHttpError` (which extends `SdkError`) for non-OK HTTP responses; `SSEClientTransport` throws `SdkHttpError` for 401-after-reauth (circuit breaker).

- [#1974](https://github.com/modelcontextprotocol/typescript-sdk/pull/1974) [`db83829`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db83829c5bd5d6659c5e7b96638b11953b0e262d) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add custom (non-spec)
  method support: a 3-arg `setRequestHandler(method, schemas, handler)` / `setNotificationHandler(method, schemas, handler)` form for vendor-prefixed methods, and a `request(req, resultSchema)` overload (also on `ctx.mcpReq.send`) for typed custom-method results. Spec-method
  calls are unchanged.

    Response result-schema validation failure now rejects with `SdkError(InvalidResult)` instead of a raw `ZodError`. Adds `SdkErrorCode.InvalidResult`.

- [#1653](https://github.com/modelcontextprotocol/typescript-sdk/pull/1653) [`6bec24a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/6bec24a14cb7e3dbe9f5e04aeb893cd0d6e8cb83) Thanks [@rechedev9](https://github.com/rechedev9)! - Add `validateClientMetadataUrl()`
  utility for early validation of `clientMetadataUrl`

    Exports a `validateClientMetadataUrl()` function that `OAuthClientProvider` implementations can call in their constructors to fail fast on invalid URL-based client IDs, instead of discovering the error deep in the auth flow.

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add the v2
  `IdJagTokenExchangeResponse` type to the public API and register its schema as an MCP spec type. `IdJagTokenExchangeResponse` is now exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, `'IdJagTokenExchangeResponse'` joins the `SpecTypeName` union,
  and `isSpecType.IdJagTokenExchangeResponse(value)` / `specTypeSchemas.IdJagTokenExchangeResponse` validate it by name — matching how the OAuth/OpenID auth schemas are already exposed. The Zod schema itself, `IdJagTokenExchangeResponseSchema`, is available from
  `@modelcontextprotocol/core`.

- [#2248](https://github.com/modelcontextprotocol/typescript-sdk/pull/2248) [`db28156`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db28156a23032290b3ce3bae00a17544c4807b8f) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Restore the 2025-11-25
  task wire types that were removed together with the task feature: the task schemas and inferred types, task members of the request/result/notification unions, the `task` request-params augmentation, the `tasks` capability key, the `isTaskAugmentedRequestParams` guard, and
  `RELATED_TASK_META_KEY`. The task feature itself remains removed — servers do not advertise the `tasks` capability and inbound `tasks/*` requests receive `-32601` — but the wire surface stays so SDKs interoperate cleanly with peers on the 2025-11-25 revision.

- [#1887](https://github.com/modelcontextprotocol/typescript-sdk/pull/1887) [`96db044`](https://github.com/modelcontextprotocol/typescript-sdk/commit/96db044fe965f0b7d5109e6d68598eaddce961c9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Export `isSpecType` and
  `specTypeSchemas` records for runtime validation of any MCP spec type by name. `isSpecType.ContentBlock(value)` is a type predicate; `specTypeSchemas.ContentBlock` is a `StandardSchemaV1Sync<ContentBlock>` validator — `validate()` returns the result synchronously. Guards are
  standalone functions, so `arr.filter(isSpecType.ContentBlock)` works. Also export the `SpecTypeName`, `SpecTypes`, and `StandardSchemaV1Sync` types.

- [#1871](https://github.com/modelcontextprotocol/typescript-sdk/pull/1871) [`9fc9070`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9fc9070b7b8e18227127aaee9869f8809a87fdb1) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Move stdio transports
  to a `./stdio` subpath export. Import `StdioClientTransport`, `getDefaultEnvironment`, `DEFAULT_INHERITED_ENV_VARS`, and `StdioServerParameters` from `@modelcontextprotocol/client/stdio`, and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The
  `@modelcontextprotocol/client` root entry no longer pulls in `node:child_process`, `node:stream`, or `cross-spawn`, fixing bundling for browser and Cloudflare Workers targets; the `@modelcontextprotocol/server` root entry drops its `node:stream` reference. Node.js, Bun, and
  Deno consumers update the import path; runtime behavior is unchanged.

### Patch Changes

- [#1897](https://github.com/modelcontextprotocol/typescript-sdk/pull/1897) [`434b2f1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/434b2f11ecec452f3dca0199f68afccd8b119dd4) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Stop bundling
  `@cfworker/json-schema` into the main package barrel. Previously `CfWorkerJsonSchemaValidator` was re-exported from the core internal barrel, so tsdown inlined the `@cfworker/json-schema` dependency into every consumer's bundle even when it was never used. The named validator
  classes are now reachable only via the explicit `@modelcontextprotocol/{client,server}/validators/{ajv,cf-worker}` subpaths and the runtime `_shims` conditional, so consumers that import only from the root entry point no longer ship the validator dep.

- [#2269](https://github.com/modelcontextprotocol/typescript-sdk/pull/2269) [`e84c3e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e84c3e9ad040eb09299b1f99dd8bdd14251ae790) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Non-SEP draft spec conformance
  fixes
    - `McpServer` now eagerly installs list/read/call handlers for every primitive capability (`tools`, `resources`, `prompts`) declared in `ServerOptions.capabilities`. Per the draft spec, a server that declares a capability MUST respond to its list method (potentially with an
      empty result) instead of returning "Method not found". Previously, handlers were only installed lazily on first registration, so a server constructed with e.g. `capabilities: { tools: {} }` and zero registered tools answered `tools/list` with `-32601`. Low-level `Server`
      users remain responsible for registering handlers for declared capabilities (documented on `ServerOptions.capabilities`).
    - Fixed pagination doc examples on `Client.listTools`/`listPrompts`/`listResources` to loop `while (cursor !== undefined)` instead of `while (cursor)` — per the draft spec, clients MUST NOT treat an empty-string cursor as the end of results.

- [#1834](https://github.com/modelcontextprotocol/typescript-sdk/pull/1834) [`42cb6b2`](https://github.com/modelcontextprotocol/typescript-sdk/commit/42cb6b2b728347d8b58a0d1940b7e63366a29ab9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Export
  `InMemoryTransport` for in-process testing.

- [#1898](https://github.com/modelcontextprotocol/typescript-sdk/pull/1898) [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add top-level `types`
  field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries
  for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.

- [#1655](https://github.com/modelcontextprotocol/typescript-sdk/pull/1655) [`1eb3123`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1eb31236e707c4f4ab9234d87db21ab3f34bf0bc) Thanks [@nielskaspers](https://github.com/nielskaspers)! - fix(client): append custom
  Accept headers to spec-required defaults in StreamableHTTPClientTransport

    Custom Accept headers provided via `requestInit.headers` are now appended to the spec-mandated Accept types instead of being overwritten. This ensures the required media types (`application/json, text/event-stream` for POST; `text/event-stream` for GET SSE) are always present
    while allowing users to include additional types for proxy/gateway routing.

- [#2268](https://github.com/modelcontextprotocol/typescript-sdk/pull/2268) [`49c0a71`](https://github.com/modelcontextprotocol/typescript-sdk/commit/49c0a711c8bf2d385f9e03b4f28ba0ff0d0db0bd) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Mark the roots, sampling, and
  logging runtime APIs as `@deprecated` per SEP-2577 (deprecated as of protocol version 2026-07-28; functional for at least twelve months). Annotates `Server.createMessage`/`listRoots`/`sendLoggingMessage`, `McpServer.sendLoggingMessage`,
  `Client.setLoggingLevel`/`sendRootsListChanged`, the `ServerContext.mcpReq.log`/`requestSampling` helpers, and the `roots`/`sampling`/`logging` capability schema fields. JSDoc/docs only — no behavior change.

- [#2275](https://github.com/modelcontextprotocol/typescript-sdk/pull/2275) [`1b53a41`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b53a415ea2c33aa11ac413fc9c2d68ccffde784) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add a configurable
  `maxBufferSize` (default 10 MB) to the stdio transports. When a single message would push the read buffer past the limit, the transport now emits an `onerror` and closes instead of growing the buffer unbounded. Configure via `new StdioClientTransport({ ..., maxBufferSize })` or
  `new StdioServerTransport(stdin, stdout, { maxBufferSize })`. The default is exported from `@modelcontextprotocol/client` / `@modelcontextprotocol/server` as `STDIO_DEFAULT_MAX_BUFFER_SIZE`.

- [#2088](https://github.com/modelcontextprotocol/typescript-sdk/pull/2088) [`16d13ab`](https://github.com/modelcontextprotocol/typescript-sdk/commit/16d13abf78b5dba5de73dfa284325b13d4219bb2) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Bundle automatic JSON Schema
  validator defaults in `@modelcontextprotocol/client` and `@modelcontextprotocol/server` runtime shims.

    Client and server pick the right validator automatically based on the runtime: the Node shim uses AJV, the browser/workerd shim uses `@cfworker/json-schema`. Both backends are bundled into the shim chunks that select them, so the default code path needs no extra installs —
    `import { McpServer } from '@modelcontextprotocol/server'` does not pull `ajv` or `@cfworker/json-schema` into the root entry chunk.

    The named validator classes remain part of the public surface for consumers who want to customize the built-in backend (pre-register schemas by `$id`, register custom AJV formats, switch dialects, change `@cfworker/json-schema` draft). They are exposed through explicit
    subpaths so they do not bloat the root index chunk:
    - `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/ajv'`
    - `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/cf-worker'`

    Importing from one of these subpaths means the corresponding peer dep (`ajv` + `ajv-formats`, or `@cfworker/json-schema`) must be in your `package.json`. The shim keeps its own vendored copy for the default path, so a project can use the subpath in some files and rely on the
    default in others.

    The `jsonSchemaValidator` interface remains the public extension point for replacing validation entirely with a custom implementation.

- [#1976](https://github.com/modelcontextprotocol/typescript-sdk/pull/1976) [`55b1f06`](https://github.com/modelcontextprotocol/typescript-sdk/commit/55b1f06cd4569e334f3435b7971f0446f1ef9be9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - refactor: subclasses
  override `_wrapHandler` hook instead of redeclaring `setRequestHandler`.

- [#1895](https://github.com/modelcontextprotocol/typescript-sdk/pull/1895) [`b256546`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b256546750277faeb7c886792aae5ed26e6904d5) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fix runtime crash on
  `tools/list` when a tool's `inputSchema` comes from zod 4.0–4.1. The SDK requires `~standard.jsonSchema` (StandardJSONSchemaV1, added in zod 4.2.0); previously a missing `jsonSchema` crashed at `undefined[io]`. `standardSchemaToJsonSchema` now detects zod 4 schemas lacking
  `jsonSchema` and falls back to the SDK-bundled `z.toJSONSchema()`, emitting a one-time console warning. zod 3 schemas (which the bundled zod 4 converter cannot introspect) and non-zod schema libraries without `jsonSchema` get a clear error pointing to `fromJsonSchema()`. The
  workspace zod catalog is also bumped to `^4.2.0`.

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
    import { fromJsonSchema } from '@modelcontextprotocol/server';
    import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

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
    - Removed unused exports from `@modelcontextprotocol/core-internal`: `SchemaInput`, `schemaToJson`, `parseSchemaAsync`, `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema`. Use the new `standardSchemaToJsonSchema` and `validateStandardSchema`
      instead.
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
