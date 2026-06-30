# @modelcontextprotocol/server

## 2.0.0-alpha.4

### Major Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Split the wire layer into per-era codecs and make protocol-revision deletions physical. Deliberate wire/schema behavior changes (see docs/migration/support-2026-07-28.md "Per-era wire codecs"):
    - `resultType` is no longer modeled by any neutral wire schema: `EmptyResultSchema` (strict) now rejects `{resultType}` bodies; on 2025-era connections a foreign `resultType` is stripped before validation instead of rejected; the member exists only inside the 2026-era codec, which requires it.
    - `CallToolResult.content` / `ToolResultContent.content` are required at the wire boundary (`content.default([])` removed): handler results without `content` are rejected with `-32602` instead of silently defaulted, and content-less wire results fail the client parse loudly.
    - Custom (3-arg) handlers now receive `_meta` minus the reserved envelope keys instead of having it deleted before params validation.
    - `specTypeSchemas` re-scoped to the neutral model: result validators no longer accept `resultType`; task message-type validators and `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed).
    - Role aggregate types/schemas (`ClientRequest`, `ServerResult`, …) no longer carry task vocabulary; the deprecated `Task*` types remain importable unchanged.
    - Era-mismatched spec methods fail physically: inbound era-deleted methods get `-32601` even with a handler registered; outbound sends throw `SdkErrorCode.MethodNotSupportedByProtocolVersion` locally.
    - Value guards (`isCallToolResult`, …) are documented as neutral-shape consumer checks, not wire validators.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `createMcpHandler` now returns a web-standards-only `{ fetch, close, notify, bus }` handler — the shape Workers/Bun/Deno expect from `export default`. The duck-typed `.node(req, res, parsedBody?)` face is removed; Node frameworks (Express, Fastify, plain `node:http`) wrap the
  handler once with the new `toNodeHandler(handler, { onerror? })` exported from `@modelcontextprotocol/node`, which converts the Node request to a web-standard `Request`, calls `handler.fetch`, and writes the `Response` back honoring write backpressure. The optional `onerror`
  receives the adapter-level error fallback (request conversion / `handler.fetch` throw) before the `500` response is written, restoring observability parity with the removed `.node` face. `NodeIncomingMessageLike` and `NodeServerResponseLike` move from
  `@modelcontextprotocol/server` to `@modelcontextprotocol/node`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Hide wire-only protocol members from the public surface, at the type level and at runtime. `resultType` (the 2026-07-28 result discrimination field) is no longer declared on any public result type — the wire schemas keep parsing it, and the client funnel now consumes it raw-first: `'complete'` results are stripped to the public shape and any other kind (e.g. `input_required`) rejects with the new `SdkErrorCode.UnsupportedResultType` instead of masking into an empty success. The reserved `_meta` envelope keys are lifted out of inbound requests and notifications before handlers run, and the multi-round-trip retry fields (`inputResponses`, `requestState`) out of inbound requests only (the spec reserves those names on client-initiated requests; notification params keep them), so handler params keep the 2025-era shape; for requests the lifted material surfaces at `ctx.mcpReq.envelope`, `ctx.mcpReq.inputResponses`, and `ctx.mcpReq.requestState` (notifications have no ctx — their lifted envelope keys are not surfaced). High-level client/server methods now return the named public result types (`Promise<CallToolResult>` etc.). Task wire vocabulary stays importable but is `@deprecated` and excluded from the typed method maps (`RequestMethod`/`RequestTypeMap`/`ResultTypeMap`/`NotificationTypeMap`), and `callTool` is typed as plain `CallToolResult`. See docs/migration/support-2026-07-28.md "Wire-only members hidden from public types".

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

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-1613 / SEP-2106 (JSON Schema 2020-12 posture): the Node default JSON Schema validator is now `Ajv2020` (true draft 2020-12) instead of the draft-07 `Ajv` class — `$defs`/`prefixItems`/`unevaluatedProperties`/`dependentRequired` are now enforced where they were previously silently ignored; to opt back, construct the draft-07 instance with the v1 defaults — `const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }); addFormats(ajv);` — and pass `new AjvJsonSchemaValidator(ajv)`. Schemas declaring a `$schema` other than 2020-12 are rejected with a clear error rather than mis-validating. `outputSchema` may now have a non-object root and `CallToolResult.structuredContent` is widened to `unknown` (a deliberate source-level break for typed consumers — see the migration guide for the narrowing pattern). Toward 2025-era clients McpServer wraps a non-object `outputSchema` (and the matching `structuredContent`) in a `{result: …}` envelope so the tool stays callable, with same-document `$ref`/`$dynamicRef` pointers rewritten to keep resolving — low-level `Server` users (those bypassing `McpServer` and registering a `tools/call` handler directly) get the same wrap by routing the result through the new `Server.projectCallToolResult(result, advertisedOutputSchema)`. Independently, on every era (the SEP's MUST applies regardless of client version), McpServer auto-appends a `TextContent` JSON serialisation when a handler returns non-object `structuredContent` without its own text block. The `structuredContent` presence check is `!== undefined` (not falsy) on both sides. Thanks @mattzcarey (#2249).

### Minor Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `createRequestStateCodec({ key, ttlSeconds?, bind? })`, an opt-in HMAC-SHA256 sealing helper for the multi-round-trip `requestState`: `mint` seals a JSON-serializable payload (with TTL and optional context binding) and `verify` drops directly into `ServerOptions.requestState.verify`. WebCrypto-based and runtime-neutral; verification is fail-closed and constant-time. The `ServerOptions.requestState.verify` hook's return type is widened to `unknown | Promise<unknown>` so the codec's `verify` is directly assignable; the seam captures the hook's resolved value (the decoded payload) and hands it to handlers via the typed `ctx.mcpReq.requestState<T>()` accessor.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Results of the cacheable 2026-07-28 operations (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`) now always carry the revision's required `ttlMs`/`cacheScope` fields when served on that revision, defaulting to `ttlMs: 0` / `cacheScope: 'private'`. Servers can configure the emitted values with the new `ServerOptions.cacheHints` option (per operation) and the new `cacheHint` member of the `registerResource` config (per resource); resolution is per field, most specific author first: cache fields returned by a handler win over the per-resource hint, which wins over the per-operation hint, and configured hints are validated at construction/registration time (`RangeError` on invalid values). Responses on 2025-era connections are unchanged and never carry these fields. Note for untyped callers: `registerResource` now interprets a `cacheHint` key in its config object — it is validated and kept out of the resource's list metadata, where it was previously passed through as ordinary metadata.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `SdkErrorCode.MethodNotSupportedByProtocolVersion`: a typed local error raised before anything reaches the transport when a spec method is sent toward a peer whose negotiated protocol version's wire era does not define it (for example `tasks/get` toward a 2026-07-28 peer). The protocol layer now resolves a per-era wire codec from the connection's negotiated protocol version (instance state on `Client`/`Server`, with the legacy era as the pre-negotiation default) and resolves per-method schemas at dispatch time instead of registration time; an edge classification on an inbound message is validated against that instance era, and a mismatch is rejected as an entry/routing error. Behavior on existing (2025-era) connections is unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Revise `createMcpHandler`'s legacy handling (a behavior change to the unreleased entry). The entry now serves 2025-era (non-envelope) traffic **by default** through per-request stateless serving from the same factory — `legacy: 'stateless'` is the default rather than an
  opt-in — and the strict, modern-only posture is selected with the new `legacy: 'reject'` value (the earlier alpha's default). The handler-valued `legacy` option (bring-your-own legacy serving) is removed: existing legacy deployments (for example a sessionful streamable
  HTTP wiring) keep serving 2025 traffic by routing in user land with the new `isLegacyRequest(request, parsedBody?)` export, which runs the entry's own classification step — it returns `true` only for requests with no per-request `_meta` envelope claim, while malformed or
  incomplete modern claims are NOT legacy and must be routed to the modern handler, which answers them with the documented validation errors. The predicate classifies a clone, so the routed request body stays readable. `legacyStatelessFallback` remains exported as a
  standalone fetch-shaped handler with the same stateless serving as the default.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `createMcpHandler(factory, { legacy?, onerror?, responseMode? })`, an HTTP entry point that serves the 2026-07-28 draft revision per request: each envelope-carrying request is classified once, served on a fresh instance from the factory bound to the claimed revision,
  and answered with a JSON body or a lazily-upgraded SSE stream. 2025-era serving is selected with the `legacy` option (`'stateless'` — the default — for per-request stateless serving via the existing streamable HTTP transport, `'reject'` for a modern-only strict endpoint
  that answers 2025-era requests with the unsupported-protocol-version error naming its supported revisions). The handler is a web-standard `{ fetch, close, notify, bus }` object: `fetch(request, { authInfo?, parsedBody? })` is the only request face (Node frameworks wrap it with
  `toNodeHandler(handler)` from `@modelcontextprotocol/node`), and `close()` tears down in-flight modern exchanges. Also exported: `legacyStatelessFallback` (the same stateless legacy serving as a standalone fetch-shaped handler), the `PerRequestHTTPServerTransport` single-exchange transport and the
  `classifyInboundRequest` classifier for hand-wired compositions, and the supporting types. `responseMode: 'json'` never streams and drops mid-call notifications (progress, logging and other related messages emitted before the result); listen-class subscription streams are
  always served over SSE. The entry performs no Origin/Host validation (use the middleware packages) and no token verification — `authInfo` is pass-through and never derived from request headers.

- [#2381](https://github.com/modelcontextprotocol/typescript-sdk/pull/2381) [`f0bf785`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f0bf785239af67f0cfce24575fec9c1193deaff1) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Serve `input_required` handlers on 2025-era connections: the legacy shim (on by default) converts each embedded request of an `input_required` return into a real server→client request (`elicitation/create`, `sampling/createMessage`, `roots/list`) over the live session — stamped with the originating request's id for stream association — and re-enters the handler with the collected `inputResponses` until a final result. Handlers are written once in the 2026 `inputRequired(...)` style and serve both eras; the previous loud `-32603` failure remains available via `ServerOptions.inputRequired.legacyShim: false`. Knobs: `inputRequired.maxRounds` (default 8) and `inputRequired.roundTimeoutMs` (default 600 000 ms per leg; legs carry a progressToken so a client reporting progress mid-leg resets the leg timeout). Semantics mirror the modern client driver exactly: per-round replaced `inputResponses`, byte-exact `requestState` echo with the verify hook running every round, paced requestState-only rounds, and elicitation accepted content passed through UNVALIDATED (the handler validates via the schema-aware `acceptedContent` overload, exactly as on the 2026 era). URL-mode legs synthesize the `elicitationId` the 2025-11-25 wire requires. Failures surface per family (`tools/call` → `isError` tool result; `prompts/get` / `resources/read` → JSON-RPC error); stateless legacy HTTP degrades to a clean capability refusal; the shim emits no progress of its own (the originating progressToken is the handler's single must-increase stream — the shim never adds a second author to it).

    `ctx.mcpReq.requestState` is now a typed accessor: `ctx.mcpReq.requestState<T>()` returns the payload the configured `requestState.verify` hook resolved with (e.g. `createRequestStateCodec.verify` — the hook's return value is now load-bearing; verifiers that are not also decoders should resolve `undefined`), the raw wire string when no hook is configured, or `undefined` when the round carried no state. Code that read the property directly becomes a call: `ctx.mcpReq.requestState` → `ctx.mcpReq.requestState<string>()`. Note the member is now always present (a function), so truthiness no longer means "has state", and it is dropped by JSON serialization of the context.

    New typed readers for `inputResponses`, exported from `@modelcontextprotocol/server`: a schema-aware `acceptedContent(responses, key, schema)` overload (validates untrusted accepted content against any synchronous Standard Schema) and `inputResponse(responses, key)` (discriminated `missing | elicit | sampling | roots` view, for decline/cancel detection and the non-elicitation kinds). Content conveniences like text extraction stay in application code as one-liners over the discriminated view.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `MissingRequiredClientCapabilityError`, the typed error class for the 2026-07-28 `-32021` protocol error (processing a request requires a capability the client did not declare). Its `data.requiredCapabilities` lists the missing capabilities and `ProtocolError.fromError` recognizes the code/data shape. The 2026-07-28 HTTP entry gains a pre-dispatch gate that refuses a request requiring an undeclared client capability with this error and HTTP status `400`; no method served on the 2026-07-28 registry currently carries such a requirement, so observable behavior is unchanged until methods with capability requirements exist.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the server side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). Handlers for `tools/call`, `prompts/get`, and `resources/read` can return the value built by `inputRequired()` (exported from the server package together with `acceptedContent()`)
  to request additional client input in-band; the structured-content requirement and the tools/call result-schema validation are skipped for that return, the encode seam emits it as `resultType: 'input_required'`, and the handler reads the responses on re-entry from
  `ctx.mcpReq.inputResponses` (with non-bare entries reported via `ctx.mcpReq.droppedInputResponseKeys`). The seam re-checks the at-least-one rule for hand-built results, checks every embedded request against the capabilities the client declared on that request's envelope
  (answering the typed `-32021` error on violation), and fails loudly — never emitting a mis-typed result — when an input-required value is returned from any other method. Toward a 2025-era request the return is served by the default-on legacy shim (real server→client requests plus handler re-entry); the loud failure for that case remains available via `ServerOptions.inputRequired.legacyShim: false`. A `UrlElicitationRequiredError` escaping a handler on a 2026-era request
  fails as an internal error with a clear steer to `inputRequired.elicitUrl(...)`, so the `-32042` error never reaches the 2026-07-28 wire; 2025-era serving keeps today's `-32042` behavior
  exactly. The typed local error raised when push-style server-to-client request APIs are used while serving a 2026-era request now steers to `inputRequired(...)`. Tool, prompt, and resource callback types accept the new return alongside their existing result types; 2025-era
  wire behavior is unchanged. An optional `ServerOptions.requestState.verify` hook lets a server integrity-check the echoed `requestState` before the handler runs — a throw answers the wire-level `-32602` Invalid Params error with `data.reason: 'invalid_request_state'`; the SDK provides no default verification.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add Origin header validation alongside the existing Host header validation. The server package gains framework-agnostic helpers (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`); the Express, Hono and Fastify adapters gain `originValidation` /
  `localhostOriginValidation` middleware and a new `allowedOrigins` option on their app factories, which now arm Origin validation by default for localhost-class binds (mirroring the Host validation ladder; the 0.0.0.0-without-allowlist warning is unchanged). Requests
  without an `Origin` header pass — non-browser MCP clients are unaffected — while a present `Origin` that is not allowed or cannot be parsed (including the opaque `null` origin) is rejected with `403`. The Node adapter ships `hostHeaderValidation` / `originValidation`
  request guards for plain `node:http` servers, which previously had no validation helpers.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2243 `Mcp-Param-*` server-side validation (protocol revision 2026-07-28). On the modern (2026-07-28) serving path, `createMcpHandler` now validates `Mcp-Param-{Name}` headers against the named tool's `x-mcp-header` declarations and the body `arguments` before dispatch: a missing header for a present body value, a header that decodes to a different value than the body, or an invalid `=?base64?…?=` sentinel is rejected with `400 Bad Request` and JSON-RPC `-32020` (`HeaderMismatch`) — the same shape the existing standard-header cross-checks emit. A `null`/absent body value passes regardless of any header (the spec's "server MUST NOT expect the header" rows). `McpServer.registerTool` now warns at registration time when an `x-mcp-header` declaration violates the spec's constraints. The 2025-era serving paths and the low-level `Server` factory shape are unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2243 standard-header server-side validation (protocol revision 2026-07-28). On the modern (2026-07-28) serving path, `createMcpHandler` now enforces the required `Mcp-Method` and `Mcp-Name` standard request headers in addition to the existing `MCP-Protocol-Version` and `Mcp-Method` cross-checks: a modern request without an `Mcp-Method` header, a `tools/call` / `prompts/get` / `resources/read` request without an `Mcp-Name` header, an `Mcp-Name` header carrying an invalid `=?base64?…?=` sentinel, and an `Mcp-Name` header whose (decoded) value disagrees with the body's `params.name` / `params.uri` are all rejected with `400 Bad Request` and JSON-RPC `-32020` (`HeaderMismatch`). The 2025-era serving paths are unchanged.

    New public surface:
    - `@modelcontextprotocol/server`: the `mcpNameHeader` field on `InboundHttpRequest`, and the `'standard-header-validation'` member of `InboundValidationRung` (with `client-capabilities` / `param-header-validation` renumbered).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `serveStdio(factory, options?)` (exported from `@modelcontextprotocol/server/stdio`), the connection-pinned stdio entry point for serving the 2026-07-28 draft revision on long-lived connections. The entry owns the transport and the era decision: the client's opening
  exchange selects the era (a 2025 `initialize` handshake, 2026-07-28 per-request `_meta` envelope traffic, or a `server/discover` probe followed by either), and ONE instance from the factory is pinned to the connection and serves only that era — mirroring how
  `createMcpHandler` classifies each HTTP request before constructing an instance. 2025-era openings are served by default; `legacy: 'reject'` answers them with the unsupported-protocol-version error naming the supported modern revisions instead. A `transport` option
  accepts a bring-your-own `StdioServerTransport` (for example over a Unix domain socket); `onerror` reports out-of-band errors; the returned handle's `close()` tears the connection down.

    Removed: `ServerOptions.eraSupport` (introduced in an earlier 2.0 alpha, never in a stable release). A hand-constructed `Server`/`McpServer` serves only the 2025-era protocol it was written for; serving the 2026-07-28 revision always goes through a serving entry. Migrate
    `new McpServer(info, { eraSupport: 'dual-era' })` + `connect(new StdioServerTransport())` to `serveStdio(() => new McpServer(info))`, and `eraSupport: 'modern'` to `serveStdio(factory, { legacy: 'reject' })`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Align the 2026-07-28 protocol error codes to the spec renumber: `HeaderMismatch` is now `-32020` (was `-32001`), `MissingRequiredClientCapability` is now `-32021` (was `-32003`), and `UnsupportedProtocolVersion` is now `-32022` (was `-32004`). These codes are part of the draft 2026-07-28 protocol revision only and have never appeared on a 2025-era wire — the 2025 serving paths and the SDK-conventional `-32001` (`Session not found`) on the stateful Streamable HTTP transport are unchanged. `ProtocolErrorCode.MissingRequiredClientCapability`, `ProtocolErrorCode.UnsupportedProtocolVersion`, the `HEADER_MISMATCH_ERROR_CODE` constant, and the `HEADER_MISMATCH` / `MISSING_REQUIRED_CLIENT_CAPABILITY` / `UNSUPPORTED_PROTOCOL_VERSION` spec-type constants now carry the renumbered values; the `UnsupportedProtocolVersionError` and `MissingRequiredClientCapabilityError` classes (and `ProtocolError.fromError` recognition) follow. The client probe classifier recognizes `-32022` for the corrective continuation and the SEP-2243 one-refresh-on-miss retry triggers on `-32020`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `subscriptions/listen` graceful close: per spec PR #2953, a server-side graceful close (`createMcpHandler` / `serveStdio` `close()`) now emits the empty `subscriptions/listen` JSON-RPC result (the new `SubscriptionsListenResult` — `_meta` carries the subscriptionId) before closing the stream, replacing the previous server-originated `notifications/cancelled`. On the client, `McpSubscription.closed` now resolves `'graceful'` for this signal (added alongside `'local'` and `'remote'`); a stream close without a result remains `'remote'` (unexpected disconnect).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `subscriptions/listen` (SEP-1865) is served by both serving entries on protocol revision 2026-07-28. The entry owns ack-first, per-stream filtering, subscription-id stamping, keepalive (HTTP), the pre-ack `-32603` capacity guard, and teardown (HTTP stream close; one
  `notifications/cancelled` per subscription on stdio). `server/discover` now advertises `listChanged`/`subscribe` capability bits — the rider that suppressed them until listen was served is discharged.

    Under `createMcpHandler` the consumer's factory **is** constructed for `subscriptions/listen` (a capabilities-only probe so the acknowledged filter reflects what the server advertises; the instance is never connected and is closed immediately). Per-request authorization performed inside the factory therefore sees listen requests; token verification still belongs at the middleware layer mounted in front of the entry.

    New public surface:
    - `@modelcontextprotocol/server`: `ServerEventBus`, `ServerEvent`, `ServerNotifier` (types); `InMemoryServerEventBus` (class).
    - `McpHttpHandler` gains `.notify` (`ServerNotifier`: `toolsChanged()`, `promptsChanged()`, `resourcesChanged()`, `resourceUpdated(uri)`) and `.bus` (the `ServerEventBus` listen streams subscribe to).
    - `CreateMcpHandlerOptions` gains `bus?: ServerEventBus` (an in-process `InMemoryServerEventBus` is created when omitted), `maxSubscriptions?: number` (default 1024), and `keepAliveMs?: number` (default 15000).
    - `ServeStdioOptions` gains `maxSubscriptions?: number` (default 1024). On a modern-pinned connection `serveStdio` routes the pinned instance's existing `send*ListChanged()` calls onto active subscriptions; legacy connections are unchanged.
    - `@modelcontextprotocol/server`: `SUBSCRIPTION_ID_META_KEY` (const); `SubscriptionFilter`, `SubscriptionsListenRequest`, `SubscriptionsListenRequestParams`, `SubscriptionsAcknowledgedNotification`, `SubscriptionsAcknowledgedNotificationParams` (types).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Wire `server/discover` (protocol revision 2026-07-28) into the typed request funnel and serve it era-aware. The request joins `ClientRequestSchema`/`ServerResultSchema`/`ResultTypeMap` (per-era availability stays with the wire registries: only the 2026-era registry serves
  it), and `Client.discover()` issues it as a typed request on 2026-era connections. A `Server` whose `supportedProtocolVersions` list carries a modern (2026-07-28+) revision installs the `server/discover` handler, advertising ONLY its modern revisions and excluding the
  listChanged/subscribe-class capabilities until the `subscriptions/listen` flow ships; servers with today's default list are unchanged and keep answering `-32601`. The `initialize` handshake is now era-aware in the other direction: its accept check and counter-offer consult
  only the legacy subset of the supported versions — a 2026-era revision is never negotiated via `initialize` — so a 2025-era client can never be offered a 2026 version string; with the default list this is byte-identical to previous behavior. Serving the 2026 revision to
  ordinary HTTP/stdio traffic arrives with an upcoming server-side entry point: today the negotiation surface is client-side, and `mode: 'auto'` falls back cleanly against current SDK servers.

### Patch Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Deprecate `Server.getClientCapabilities()`, `Server.getClientVersion()` and `Server.getNegotiatedProtocolVersion()` in favor of the per-request handler context: on 2026-07-28 requests the validated `_meta` envelope carries the client's identity (`ctx.mcpReq.envelope`),
  and instances serving that revision through `createMcpHandler` are backfilled per request so the accessors keep answering. Behavior on 2025-era connections is unchanged; the accessors remain functional.

- [#2394](https://github.com/modelcontextprotocol/typescript-sdk/pull/2394) [`801111e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/801111ea152c1ba08f6dda0b27d712759aeb46bf) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fix the published declaration files for consumers compiling with `skipLibCheck: false`: the bundled `.d.mts` no longer leaves a dangling `URIComponent` reference (ajv's published types import it from `fast-uri`, whose export-assigned namespace the dts bundler cannot link — the type is now inlined via a dts-only path mapping), and no longer imports `json-schema-typed` from an undeclared dependency (it is inlined via `dts.resolve`). `@modelcontextprotocol/node` and `@modelcontextprotocol/server` drop stale `typesVersions` entries pointing at subpaths that never shipped. Package READMEs note that TypeScript >=6.0 requires `"types": ["node"]` since the published declarations reference `Buffer`.

- [#2390](https://github.com/modelcontextprotocol/typescript-sdk/pull/2390) [`6cc7b1c`](https://github.com/modelcontextprotocol/typescript-sdk/commit/6cc7b1cb66cabf23423ba0fdf06e2d1c2fcf936f) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `isLegacyRequest` docs: lead with the single-argument form. `isLegacyRequest(request)` is the whole API — the body is read from an internal clone, so the request you pass stays readable for whichever handler you route it to. `parsedBody` is an optional perf escape for a body you already hold parsed (and the way in for an already-consumed stream, e.g. behind `express.json()`), not a required companion. Documentation only; no behavior change.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Pin the modern (2026-07-28) HTTP serving path's rejection codes to the assignments the published conformance suite asserts: a header/body cross-check mismatch (`MCP-Protocol-Version` or `Mcp-Method` disagreeing with the request body) is now rejected with `-32020` (HeaderMismatch), and a request whose protocol-version header names a modern revision but whose body is missing the `_meta` envelope (or its required protocol-version key) is rejected with `-32602` invalid params naming the missing key(s). Both keep HTTP 400. These cells previously emitted a provisional `-32004` while the upstream error-code discussion was open. The envelope-less rejection on a modern-only endpoint (`-32022` with the supported-versions list), the 2025-era serving paths, and the client-side probe handling are unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `ctx.mcpReq.log()` now emits its `notifications/message` notification request-related (like progress and `ctx.mcpReq.notify`), so handler-emitted log messages are delivered when the server is hosted per request via `createMcpHandler` instead of being silently dropped. On a 2026-07-28 request the level filter consults the per-request `_meta` `io.modelcontextprotocol/logLevel` key (the modern equivalent of `logging/setLevel`); per the spec, an absent key means no `notifications/message` is sent for that request.

    **2025-era delivery-channel change (spec-conformance correction).** On a 2025-era sessionful Streamable HTTP transport, handler-emitted log messages now ride the per-request POST response stream instead of the standalone GET stream. This is a correction to the 2025-11-25 specification: `docs/specification/2025-11-25/basic/transports.mdx` §"Sending Messages to the Server" item 6 says JSON-RPC messages on the POST response stream SHOULD relate to the originating client request, and §"Listening for Messages from the Server" item 4 says messages on the GET stream SHOULD be unrelated to any concurrently-running client request — so a log emitted from a handler context belongs on the POST stream. Clients reading handler logs off the standalone GET stream will now see them on the per-request POST stream instead. The eventStore-resumable case (a log emitted after `closeSSE()` while the client has not yet reconnected) is handled by the store-first persistence behavior in `WebStandardStreamableHTTPServerTransport.send()`. The session-scoped `Server.sendLoggingMessage()` API is unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `WebStandardStreamableHTTPServerTransport`: request-related events (progress, `ctx.mcpReq.notify`, handler-emitted log) and the final response are now persisted to the configured `eventStore` whenever the request is in flight, regardless of whether a live SSE writer currently exists — mirroring the standalone-SSE path's store-first semantics. This fixes the `closeSSE()` poll-and-replay drop (events emitted after `closeSSE()` were previously silently lost) and aligns with the 2025-11-25 specification ("disconnection SHOULD NOT be interpreted as the client cancelling its request"). When an `eventStore` is configured, a final response sent while no per-request stream is connected is stored for replay and returns cleanly instead of throwing "No connection established"; a `Last-Event-ID` reconnect after the request has been retired replays the stored response and then closes the resumed stream. When no `eventStore` is configured, the same condition is surfaced via `onerror` (the response is undeliverable) and the request id is retired.

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

- [#1974](https://github.com/modelcontextprotocol/typescript-sdk/pull/1974) [`db83829`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db83829c5bd5d6659c5e7b96638b11953b0e262d) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add custom (non-spec)
  method support: a 3-arg `setRequestHandler(method, schemas, handler)` / `setNotificationHandler(method, schemas, handler)` form for vendor-prefixed methods, and a `request(req, resultSchema)` overload (also on `ctx.mcpReq.send`) for typed custom-method results. Spec-method
  calls are unchanged.

    Response result-schema validation failure now rejects with `SdkError(InvalidResult)` instead of a raw `ZodError`. Adds `SdkErrorCode.InvalidResult`.

- [#2353](https://github.com/modelcontextprotocol/typescript-sdk/pull/2353) [`c59dc3a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c59dc3aa1a633d27fbbe873f1a430483cf7440f8) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Support `icons` on the
  high-level `McpServer.registerTool()` and `registerPrompt()` config objects (and on their `update()` methods). Tool and prompt icons now surface in `tools/list` and `prompts/list`. Resource, resource-template, and server-info (`Implementation`) icons already passed through.
  This closes the gap with the MCP spec, which allows `icons` on tools, resources, resource templates, and prompts.

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

- [#2280](https://github.com/modelcontextprotocol/typescript-sdk/pull/2280) [`e8c7180`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e8c7180109b417eef5cc22b7e9d821ab1c119a69) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Bound the
  protocol-version checks gating SSE resumability behavior (priming events and `closeSSEStream` callbacks) in the Streamable HTTP server transport. Previously an open-ended `>= '2025-11-25'` comparison let unknown future protocol version strings from an `initialize` request body
  enable this behavior; the version must now also be one of the transport's supported protocol versions. Behavior for all currently supported protocol versions is unchanged.

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

- [#1788](https://github.com/modelcontextprotocol/typescript-sdk/pull/1788) [`df4b6cc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/df4b6cc88d6f24fc857519cf506a7a039f532637) Thanks [@claygeo](https://github.com/claygeo)! - Prevent stack overflow in
  StreamableHTTPServerTransport.close() with re-entrant guard

- [#1855](https://github.com/modelcontextprotocol/typescript-sdk/pull/1855) [`2c0c481`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2c0c481cb9dbfd15c8613f765c940a5f5bace94d) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - Add `| undefined` to
  optional callback and function properties on `WebStandardStreamableHTTPServerTransportOptions` (`sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`) and corresponding private fields.

    This fixes TS2430 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where optional properties with function types need explicit `| undefined` to match their emitted declarations.

- [#1898](https://github.com/modelcontextprotocol/typescript-sdk/pull/1898) [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add top-level `types`
  field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries
  for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.

- [#1901](https://github.com/modelcontextprotocol/typescript-sdk/pull/1901) [`e15a8ef`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e15a8ef3be19520d8159ae9f5b464ba3ac80a5ab) Thanks [@felixweinberger](https://github.com/felixweinberger)! -
  `registerTool`/`registerPrompt` accept a raw Zod shape (`{ field: z.string() }`) for `inputSchema`/`outputSchema`/`argsSchema` in addition to a wrapped Standard Schema. Raw shapes are auto-wrapped with `z.object()`. The raw-shape overloads are `@deprecated`; prefer wrapping
  with `z.object()`.

    Also widens the `completable()` constraint from `StandardSchemaWithJSON` to `StandardSchemaV1` so v1's `completable(z.string(), fn)` continues to work.

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

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

### Minor Changes

- [#1673](https://github.com/modelcontextprotocol/typescript-sdk/pull/1673) [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - refactor: extract task
  orchestration from Protocol into TaskManager

    **Breaking changes:**
    - `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`

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

### Patch Changes

- [#1758](https://github.com/modelcontextprotocol/typescript-sdk/pull/1758) [`e86b183`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e86b1835ccf213c3799ac19f4111d01816912333) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tasks - disallow requesting
  a null TTL

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1372](https://github.com/modelcontextprotocol/typescript-sdk/pull/1372) [`3466a9e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3466a9e0e5d392824156d9b290863ae08192d87e) Thanks [@mattzcarey](https://github.com/mattzcarey)! - missing change for fix(client):
  replace body.cancel() with text() to prevent hanging

- [#1824](https://github.com/modelcontextprotocol/typescript-sdk/pull/1824) [`fcde488`](https://github.com/modelcontextprotocol/typescript-sdk/commit/fcde4882276cb0a7d199e47f00120fe13f7f5d47) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Drop `zod` from
  `peerDependencies` (kept as direct dependency)

    Since Standard Schema support landed, `zod` is purely an internal runtime dependency used for protocol message parsing. User-facing schemas (`registerTool`, `registerPrompt`) accept any Standard Schema library. `zod` remains in `dependencies` and auto-installs; users no
    longer need to install it alongside the SDK.

- [#1761](https://github.com/modelcontextprotocol/typescript-sdk/pull/1761) [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Convert remaining
  capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()`, the task capability helpers in `experimental/tasks/helpers.ts`, and the sampling/elicitation capability checks in
  `experimental/tasks/server.ts`.

- [#1433](https://github.com/modelcontextprotocol/typescript-sdk/pull/1433) [`78bae74`](https://github.com/modelcontextprotocol/typescript-sdk/commit/78bae7426d4ca38216c0571b5aa7806f58ab81e4) Thanks [@codewithkenzo](https://github.com/codewithkenzo)! - Fix transport errors being
  silently swallowed by adding missing `onerror` callback invocations before all `createJsonErrorResponse` calls in `WebStandardStreamableHTTPServerTransport`. This ensures errors like parse failures, invalid headers, and session validation errors are properly reported via the
  `onerror` callback.

- [#1660](https://github.com/modelcontextprotocol/typescript-sdk/pull/1660) [`689148d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/689148dc7235f53244869ed64b2ecc9ec4ef70f1) Thanks [@rechedev9](https://github.com/rechedev9)! - fix(server): propagate negotiated
  protocol version to transport in \_oninitialize

- [#1568](https://github.com/modelcontextprotocol/typescript-sdk/pull/1568) [`f1ade75`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f1ade75b67a2b46b06316fa4e5caa1d277537cc7) Thanks [@stakeswky](https://github.com/stakeswky)! - Handle stdout errors (e.g. EPIPE)
  in `StdioServerTransport` gracefully instead of crashing. When the client disconnects abruptly, the transport now catches the stdout error, surfaces it via `onerror`, and closes.

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
