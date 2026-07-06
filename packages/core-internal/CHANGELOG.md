# @modelcontextprotocol/core-internal

## 2.0.0-beta.1

### Patch Changes

- [#2399](https://github.com/modelcontextprotocol/typescript-sdk/pull/2399) [`3c7ddaf`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3c7ddafa05d8f17fb52168bf4638f09251c3d0ff) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Return HTTP 400 for a `MissingRequiredClientCapabilityError` (`-32021`) produced after dispatch. The spec mandates `400 Bad Request` for this error with no condition on where it arose, but only the pre-dispatch capability gate honored that; the post-handler emission — the `input_required` gate rejecting an embedded request whose required capability the caller did not declare — surfaced in-band on HTTP 200. The JSON-RPC error body is unchanged, every other error code (including a handler relaying a downstream peer's `-32020`/`-32022`) keeps the origin-keyed in-band behavior, and the mapping only applies while the response is uncommitted: an exchange that already streamed — or one hosted with `responseMode: 'sse'`, which opens its stream at dispatch end — keeps its committed 200 and carries the error in-stream.

## 2.0.0-alpha.3

### Major Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Split the wire layer into per-era codecs and make protocol-revision deletions physical. Deliberate wire/schema behavior changes (see docs/migration/support-2026-07-28.md "Per-era wire codecs"):
    - `resultType` is no longer modeled by any neutral wire schema: `EmptyResultSchema` (strict) now rejects `{resultType}` bodies; on 2025-era connections a foreign `resultType` is stripped before validation instead of rejected; the member exists only inside the 2026-era codec, which requires it.
    - `CallToolResult.content` / `ToolResultContent.content` are required at the wire boundary (`content.default([])` removed): handler results without `content` are rejected with `-32602` instead of silently defaulted, and content-less wire results fail the client parse loudly.
    - Custom (3-arg) handlers now receive `_meta` minus the reserved envelope keys instead of having it deleted before params validation.
    - `specTypeSchemas` re-scoped to the neutral model: result validators no longer accept `resultType`; task message-type validators and `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed).
    - Role aggregate types/schemas (`ClientRequest`, `ServerResult`, …) no longer carry task vocabulary; the deprecated `Task*` types remain importable unchanged.
    - Era-mismatched spec methods fail physically: inbound era-deleted methods get `-32601` even with a handler registered; outbound sends throw `SdkErrorCode.MethodNotSupportedByProtocolVersion` locally.
    - Value guards (`isCallToolResult`, …) are documented as neutral-shape consumer checks, not wire validators.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Hide wire-only protocol members from the public surface, at the type level and at runtime. `resultType` (the 2026-07-28 result discrimination field) is no longer declared on any public result type — the wire schemas keep parsing it, and the client funnel now consumes it raw-first: `'complete'` results are stripped to the public shape and any other kind (e.g. `input_required`) rejects with the new `SdkErrorCode.UnsupportedResultType` instead of masking into an empty success. The reserved `_meta` envelope keys are lifted out of inbound requests and notifications before handlers run, and the multi-round-trip retry fields (`inputResponses`, `requestState`) out of inbound requests only (the spec reserves those names on client-initiated requests; notification params keep them), so handler params keep the 2025-era shape; for requests the lifted material surfaces at `ctx.mcpReq.envelope`, `ctx.mcpReq.inputResponses`, and `ctx.mcpReq.requestState` (notifications have no ctx — their lifted envelope keys are not surfaced). High-level client/server methods now return the named public result types (`Promise<CallToolResult>` etc.). Task wire vocabulary stays importable but is `@deprecated` and excluded from the typed method maps (`RequestMethod`/`RequestTypeMap`/`ResultTypeMap`/`NotificationTypeMap`), and `callTool` is typed as plain `CallToolResult`. See docs/migration/support-2026-07-28.md "Wire-only members hidden from public types".

### Minor Changes

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add opt-in protocol version negotiation on `ClientOptions.versionNegotiation`. The default is unchanged: without the option (or with `mode: 'legacy'`) the client performs today's 2025 connect sequence byte-identically. `mode: 'auto'` probes the server with `server/discover` at
  connect time and conservatively falls back to the plain legacy `initialize` handshake on the same connection unless the outcome is definitive modern evidence (with a supported-versions list that has no 2025-era entry there is nothing to fall back to, and connect rejects
  with a typed error instead); a network outage rejects with a typed connect error, and a probe timeout is transport-aware — on stdio it indicates
  a legacy server and falls back to `initialize` on the same stream, on HTTP it rejects with a typed timeout error.
  `mode: { pin: '<version>' }` negotiates exactly the pinned modern revision with no fallback. Probe policy lives under `probe: { timeoutMs? }` — the probe inherits the standard request timeout. The probe's `MCP-Protocol-Version`/`Mcp-Method` headers derive from the probe
  message body; the transport version slot is never touched during negotiation, so legacy-era traffic carries zero 2026 headers by construction. Adds the `SdkErrorCode.EraNegotiationFailed` code for negotiation-phase connect failures.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Dynamic Client Registration hygiene for the 2026-07-28 authorization requirements (SEP-837, SEP-2207). New `resolveClientMetadata(provider)` reads `provider.clientMetadata` and applies the spec defaults — `application_type` derived from the redirect URIs (loopback or custom scheme → `'native'`, otherwise `'web'`), `grant_types: ['authorization_code', 'refresh_token']` when omitted — and `auth()` feeds the resolved document to DCR only (scope selection still reads the raw consumer-supplied `clientMetadata` so statically-registered/CIMD clients are not pushed into `offline_access` + `prompt=consent`); consumer-set values are never overwritten. DCR rejection now throws the new `RegistrationRejectedError` carrying the HTTP status, raw body, and submitted metadata — **breaking for direct `registerClient()` callers**: rejection no longer throws `OAuthError`, so update `instanceof` checks. `OAuthClientMetadata` gains a typed `application_type?: string` field (expected `'native'` / `'web'`; tolerant on parse). `OAuthErrorCode` adds `InvalidRedirectUri`. The token-exchange, refresh, and Cross-App Access (`requestJwtAuthorizationGrant` / `exchangeJwtAuthGrant`) paths now throw the new `InsecureTokenEndpointError` for a non-`https:` token endpoint (`localhost` / `127.0.0.1` / `::1` exempt), and `auth()` surfaces it on the refresh branch instead of silently re-authorizing.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Implement RFC 9207 / RFC 8414 §3.3 OAuth issuer validation (SEP-2468). `discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not match the discovery URL (opt out via `skipIssuerValidation` / `AuthOptions.skipIssuerMetadataValidation` — security-weakening). `auth()`, `exchangeAuthorization()`, `fetchToken()`, and `transport.finishAuth(code, iss?)` now validate the authorization-callback `iss` against the recorded issuer before redeeming the code; new `IssuerMismatchError` and `validateAuthorizationResponseIssuer()` are exported.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the public surface for the 2026-07-28 authorization requirements. New `AuthOptions` type names the `auth()` options object and adds `iss` and `skipIssuerMetadataValidation` fields. `OAuthClientProvider.clientInformation()` / `.saveClientInformation()` / `.tokens()` / `.saveTokens()` accept an optional `OAuthClientInformationContext` carrying the authorization server's `issuer` so providers can key persisted credentials per authorization server. New `StoredOAuthTokens` / `StoredOAuthClientInformation` aliases add an `issuer` stamp field on top of the wire types (kept off the wire schemas so an authorization server cannot populate it) and become the parameter/return types of the credential methods. New `OAuthClientFlowError` base class in `authErrors.ts` for the flow-specific error classes that follow. All changes are additive — existing `OAuthClientProvider` implementations compile unchanged; the new fields are inert until the behavior changes that follow wire them up.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Results of the cacheable 2026-07-28 operations (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`) now always carry the revision's required `ttlMs`/`cacheScope` fields when served on that revision, defaulting to `ttlMs: 0` / `cacheScope: 'private'`. Servers can configure the emitted values with the new `ServerOptions.cacheHints` option (per operation) and the new `cacheHint` member of the `registerResource` config (per resource); resolution is per field, most specific author first: cache fields returned by a handler win over the per-resource hint, which wins over the per-operation hint, and configured hints are validated at construction/registration time (`RangeError` on invalid values). Responses on 2025-era connections are unchanged and never carry these fields. Note for untyped callers: `registerResource` now interprets a `cacheHint` key in its config object — it is validated and kept out of the resource's list metadata, where it was previously passed through as ordinary metadata.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Client request cancellation on a 2026-07-28 Streamable HTTP connection now closes that request's SSE response stream — the spec cancellation signal — instead of POSTing `notifications/cancelled`. Cancellation on a 2025-era connection, and on stdio at any era, still sends `notifications/cancelled` as before. Adds the optional `Transport.hasPerRequestStream` capability flag (set on `StreamableHTTPClientTransport`) for the protocol layer to route the per-transport cancel path.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `SdkErrorCode.MethodNotSupportedByProtocolVersion`: a typed local error raised before anything reaches the transport when a spec method is sent toward a peer whose negotiated protocol version's wire era does not define it (for example `tasks/get` toward a 2026-07-28 peer). The protocol layer now resolves a per-era wire codec from the connection's negotiated protocol version (instance state on `Client`/`Server`, with the legacy era as the pre-negotiation default) and resolves per-method schemas at dispatch time instead of registration time; an edge classification on an inbound message is validated against that instance era, and a mismatch is rejected as an entry/routing error. Behavior on existing (2025-era) connections is unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Per-request `_meta` envelope auto-emission on modern-era connections: once a client negotiates a 2026-07-28+ protocol revision (via `versionNegotiation: { mode: 'auto' }` or `{ pin }`), it automatically attaches the reserved protocol-version / client-info / client-capabilities
  `_meta` keys to every outgoing request and notification — you no longer set the envelope by hand. User-supplied `_meta` keys take precedence over the auto-attached ones; the auto-attached client-capabilities reflect what the client actually registered. Legacy-era connections
  (the default, and the `'auto'`-mode fallback) never gain these keys, so 2025-era outbound traffic is byte-identical to before.

    Adds `Client.getProtocolEra()` (`'legacy' | 'modern' | undefined`), the `ProtocolEra` type, `Client.setVersionNegotiation()` for configuring negotiation pre-connect on an already-constructed instance, and the `probe.maxRetries` knob (default `0`) which governs probe-timeout
    re-sends only — the spec-mandated `-32022` corrective continuation is never counted against it. The `versionNegotiation` default remains `'legacy'`: absent (or `mode: 'legacy'`), `connect()` runs the plain 2025 sequence, byte-identical to a v1.x client.

- [#2381](https://github.com/modelcontextprotocol/typescript-sdk/pull/2381) [`f0bf785`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f0bf785239af67f0cfce24575fec9c1193deaff1) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Serve `input_required` handlers on 2025-era connections: the legacy shim (on by default) converts each embedded request of an `input_required` return into a real server→client request (`elicitation/create`, `sampling/createMessage`, `roots/list`) over the live session — stamped with the originating request's id for stream association — and re-enters the handler with the collected `inputResponses` until a final result. Handlers are written once in the 2026 `inputRequired(...)` style and serve both eras; the previous loud `-32603` failure remains available via `ServerOptions.inputRequired.legacyShim: false`. Knobs: `inputRequired.maxRounds` (default 8) and `inputRequired.roundTimeoutMs` (default 600 000 ms per leg; legs carry a progressToken so a client reporting progress mid-leg resets the leg timeout). Semantics mirror the modern client driver exactly: per-round replaced `inputResponses`, byte-exact `requestState` echo with the verify hook running every round, paced requestState-only rounds, and elicitation accepted content passed through UNVALIDATED (the handler validates via the schema-aware `acceptedContent` overload, exactly as on the 2026 era). URL-mode legs synthesize the `elicitationId` the 2025-11-25 wire requires. Failures surface per family (`tools/call` → `isError` tool result; `prompts/get` / `resources/read` → JSON-RPC error); stateless legacy HTTP degrades to a clean capability refusal; the shim emits no progress of its own (the originating progressToken is the handler's single must-increase stream — the shim never adds a second author to it).

    `ctx.mcpReq.requestState` is now a typed accessor: `ctx.mcpReq.requestState<T>()` returns the payload the configured `requestState.verify` hook resolved with (e.g. `createRequestStateCodec.verify` — the hook's return value is now load-bearing; verifiers that are not also decoders should resolve `undefined`), the raw wire string when no hook is configured, or `undefined` when the round carried no state. Code that read the property directly becomes a call: `ctx.mcpReq.requestState` → `ctx.mcpReq.requestState<string>()`. Note the member is now always present (a function), so truthiness no longer means "has state", and it is dropped by JSON serialization of the context.

    New typed readers for `inputResponses`, exported from `@modelcontextprotocol/server`: a schema-aware `acceptedContent(responses, key, schema)` overload (validates untrusted accepted content against any synchronous Standard Schema) and `inputResponse(responses, key)` (discriminated `missing | elicit | sampling | roots` view, for decline/cancel detection and the non-elicitation kinds). Content conveniences like text extraction stay in application code as one-liners over the discriminated view.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add `MissingRequiredClientCapabilityError`, the typed error class for the 2026-07-28 `-32021` protocol error (processing a request requires a capability the client did not declare). Its `data.requiredCapabilities` lists the missing capabilities and `ProtocolError.fromError` recognizes the code/data shape. The 2026-07-28 HTTP entry gains a pre-dispatch gate that refuses a request requiring an undeclared client capability with this error and HTTP status `400`; no method served on the 2026-07-28 registry currently carries such a requirement, so observable behavior is unchanged until methods with capability requirements exist.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the client side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). The neutral `InputRequest`/`InputResponse`/`InputRequests`/`InputResponses`/`InputRequiredResult` types and the `isInputRequiredResult()` guard ship as the neutral surface (the
  `inputRequired()` builder family and the `acceptedContent()` reader are exported by the server package as part of the server-side change); the 2026-07-28 wire codec models the in-band vocabulary (embedded requests and bare responses) and the retry-channel request fields. On the
  client, an `input_required` answer to `tools/call`, `prompts/get`, or `resources/read` on a 2026-07-28 connection is now fulfilled automatically by default: the embedded requests are dispatched to the client's already-registered elicitation/sampling/roots handlers, and the
  original call is retried with the collected `inputResponses`, a byte-exact echo of the opaque `requestState`, and a fresh request id, up to `inputRequired.maxRounds` rounds (default 10; exhaustion raises a typed `InputRequiredRoundsExceeded` error carrying the last result).
  `client.callTool()` and its siblings keep returning their plain result types. `ClientOptions.inputRequired` (`autoFulfill`, `maxRounds`) configures the driver; manual mode is `autoFulfill: false` plus the per-call `allowInputRequired: true` request option and the
  `withInputRequired()` schema wrapper. Retried requests surface their `inputResponses` to server handlers as bare response objects — entries in a wrapped `{method, result}` shape are dropped and reported via `ctx.mcpReq.droppedInputResponseKeys`. 2025-era behavior is unchanged:
  the legacy wire has no `input_required` vocabulary and the legacy server-to-client request flow is untouched.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add the server side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). Handlers for `tools/call`, `prompts/get`, and `resources/read` can return the value built by `inputRequired()` (exported from the server package together with `acceptedContent()`)
  to request additional client input in-band; the structured-content requirement and the tools/call result-schema validation are skipped for that return, the encode seam emits it as `resultType: 'input_required'`, and the handler reads the responses on re-entry from
  `ctx.mcpReq.inputResponses` (with non-bare entries reported via `ctx.mcpReq.droppedInputResponseKeys`). The seam re-checks the at-least-one rule for hand-built results, checks every embedded request against the capabilities the client declared on that request's envelope
  (answering the typed `-32021` error on violation), and fails loudly — never emitting a mis-typed result — when an input-required value is returned from any other method. Toward a 2025-era request the return is served by the default-on legacy shim (real server→client requests plus handler re-entry); the loud failure for that case remains available via `ServerOptions.inputRequired.legacyShim: false`. A `UrlElicitationRequiredError` escaping a handler on a 2026-era request
  fails as an internal error with a clear steer to `inputRequired.elicitUrl(...)`, so the `-32042` error never reaches the 2026-07-28 wire; 2025-era serving keeps today's `-32042` behavior
  exactly. The typed local error raised when push-style server-to-client request APIs are used while serving a 2026-era request now steers to `inputRequired(...)`. Tool, prompt, and resource callback types accept the new return alongside their existing result types; 2025-era
  wire behavior is unchanged. An optional `ServerOptions.requestState.verify` hook lets a server integrity-check the echoed `requestState` before the handler runs — a throw answers the wire-level `-32602` Invalid Params error with `data.reason: 'invalid_request_state'`; the SDK provides no default verification.

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

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2243 `Mcp-Param-*` client-side mirroring (protocol revision 2026-07-28). On a 2026-07-28 connection over Streamable HTTP, `Client.callTool()` now mirrors tool arguments designated with `x-mcp-header` in the tool's `inputSchema` into `Mcp-Param-{Name}` HTTP headers (with the spec's `=?base64?…?=` sentinel encoding for values that are not safe plain-ASCII field values), and on a non-stdio modern connection `Client.listTools()` (and the client's internal `tools/list` cache) exclude tool definitions whose `x-mcp-header` declarations violate the spec's constraints, logging a warning naming the tool and the reason. The legacy-era `callTool` and `listTools` paths are unchanged at the wire level. Browser environments skip mirroring (dynamically named headers cannot be statically allow-listed for credentialed CORS); a conforming SEP-2243 server will reject a `tools/call` whose body carries a non-null value for an `x-mcp-header` parameter when the matching header is absent, so calling such a tool with that argument from a browser is a known limitation. New `CallToolRequestOptions.toolDefinition` lets callers supply the tool definition directly so mirroring and output-schema validation can run without a prior `tools/list`. `TransportSendOptions.headers` is added (additive, optional) for per-request HTTP headers; the Streamable HTTP transport skips reserved standard/auth header names (`authorization`, `mcp-protocol-version`, `mcp-method`, `mcp-name`, `mcp-session-id`, `content-type`); transports that share a single channel (stdio, in-memory) ignore it.

    The Streamable HTTP transport now emits the `Mcp-Name` standard header on every modern-enveloped request (`params.name` for `tools/call`/`prompts/get`, `params.uri` for `resources/read`), sentinel-encoded.

    **Behavior change (modern era only):** on a modern-enveloped request the Streamable HTTP transport now surfaces an HTTP `400` whose body is a well-formed JSON-RPC error response addressed to the pending request id in-band as a `ProtocolError` (instead of `SdkHttpError`), so the `HEADER_MISMATCH` recovery retry can fire. Legacy-era exchanges are unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2243 standard-header server-side validation (protocol revision 2026-07-28). On the modern (2026-07-28) serving path, `createMcpHandler` now enforces the required `Mcp-Method` and `Mcp-Name` standard request headers in addition to the existing `MCP-Protocol-Version` and `Mcp-Method` cross-checks: a modern request without an `Mcp-Method` header, a `tools/call` / `prompts/get` / `resources/read` request without an `Mcp-Name` header, an `Mcp-Name` header carrying an invalid `=?base64?…?=` sentinel, and an `Mcp-Name` header whose (decoded) value disagrees with the body's `params.name` / `params.uri` are all rejected with `400 Bad Request` and JSON-RPC `-32020` (`HeaderMismatch`). The 2025-era serving paths are unchanged.

    New public surface:
    - `@modelcontextprotocol/server`: the `mcpNameHeader` field on `InboundHttpRequest`, and the `'standard-header-validation'` member of `InboundValidationRung` (with `client-capabilities` / `param-header-validation` renumbered).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Align the 2026-07-28 protocol error codes to the spec renumber: `HeaderMismatch` is now `-32020` (was `-32001`), `MissingRequiredClientCapability` is now `-32021` (was `-32003`), and `UnsupportedProtocolVersion` is now `-32022` (was `-32004`). These codes are part of the draft 2026-07-28 protocol revision only and have never appeared on a 2025-era wire — the 2025 serving paths and the SDK-conventional `-32001` (`Session not found`) on the stateful Streamable HTTP transport are unchanged. `ProtocolErrorCode.MissingRequiredClientCapability`, `ProtocolErrorCode.UnsupportedProtocolVersion`, the `HEADER_MISMATCH_ERROR_CODE` constant, and the `HEADER_MISMATCH` / `MISSING_REQUIRED_CLIENT_CAPABILITY` / `UNSUPPORTED_PROTOCOL_VERSION` spec-type constants now carry the renumbered values; the `UnsupportedProtocolVersionError` and `MissingRequiredClientCapabilityError` classes (and `ProtocolError.fromError` recognition) follow. The client probe classifier recognizes `-32022` for the corrective continuation and the SEP-2243 one-refresh-on-miss retry triggers on `-32020`.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `Client.listen(filter)` opens a `subscriptions/listen` stream on a 2026-07-28-era connection, resolving once the server's acknowledged notification arrives with an `McpSubscription { honoredFilter, close(), closed }`. `closed` is a `Promise<'local' | 'remote'>` that resolves exactly once when the subscription terminates (`'local'` = you called `close()`; `'remote'` = the server cancelled, the stream ended, or the transport dropped — re-listen if you still want events) and never rejects. Change notifications delivered on the stream dispatch to the existing `setNotificationHandler` registrations — the same handlers the 2025-era unsolicited notifications fire on a legacy connection — so `listen()` is era-transparent for consumers that already register those. `close()` aborts the listen request's stream (where the transport supports it) and sends `notifications/cancelled` referencing the listen id — both, on every transport; no automatic re-listen. On a 2025-era connection `listen()` throws a typed `MethodNotSupportedByProtocolVersion` steering to `resources/subscribe` and `ClientOptions.listChanged`. `ClientOptions.listChanged` now auto-opens a listen stream on a modern connection — the filter is the intersection of the configured sub-options and the server-advertised `listChanged` capabilities; auto-open is skipped (`client.autoOpenedSubscription` stays `undefined`) when that intersection is empty; otherwise the auto-opened subscription is exposed at `client.autoOpenedSubscription`. `TransportSendOptions` gains `requestSignal` (per-request abort) and `onRequestStreamEnd` (fires when a per-request response stream ends or errors for any non-deliberate reason) on the Streamable HTTP transport.

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

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Pin the modern (2026-07-28) HTTP serving path's rejection codes to the assignments the published conformance suite asserts: a header/body cross-check mismatch (`MCP-Protocol-Version` or `Mcp-Method` disagreeing with the request body) is now rejected with `-32020` (HeaderMismatch), and a request whose protocol-version header names a modern revision but whose body is missing the `_meta` envelope (or its required protocol-version key) is rejected with `-32602` invalid params naming the missing key(s). Both keep HTTP 400. These cells previously emitted a provisional `-32004` while the upstream error-code discussion was open. The envelope-less rejection on a modern-only endpoint (`-32022` with the supported-versions list), the 2025-era serving paths, and the client-side probe handling are unchanged.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - `Protocol.request()` now rejects with `SdkError(RequestTimeout, reason)` when called with an already-aborted signal, matching in-flight aborts. Previously the raw `signal.reason` was thrown.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Complete the SEP-2577 `@deprecated` sweep on the public type surface (SEP-2596 Tier-1 obligation). Marks the full Logging type stack (`LoggingLevel`, `SetLevelRequest`, `LoggingMessageNotification` and params), the full Sampling type stack (`CreateMessageRequest`/`Result`, `SamplingMessage`, `ModelPreferences`/`ModelHint`, `ToolChoice`, `ToolUseContent`/`ToolResultContent`, and the `includeContext` enum values), the full Roots type stack (`Root`, `ListRootsRequest`/`Result`, `RootsListChangedNotification`), and `registerClient` (Dynamic Client Registration; prefer Client ID Metadata Documents per SEP-991). Mirrors the markers already present on the per-revision reference types. JSDoc only — wire behavior is unchanged; everything remains fully functional during the deprecation window (at least twelve months).

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Re-pin the 2026-07-28 draft references (spec reference types, vendored schema.json twins, example corpus) to the latest spec commit and align the 2026-era wire surface with it. Deliberate 2026-era wire behavior changes (the released 2025-11-25 surface is untouched):
    - `notifications/elicitation/complete` is no longer part of the 2026-07-28 wire registry (the draft removed the notification together with `elicitationId` on URL-mode elicitation). On connections negotiated at 2026-07-28, sending it — including via `Server.createElicitationCompletionNotifier()` — now fails locally with `SdkErrorCode.MethodNotSupportedByProtocolVersion`, and inbound copies are dropped as unknown notifications. Both remain fully supported on 2025-11-25.
    - `notifications/cancelled` on 2026-era connections now parses with a revision-exact schema that requires `requestId` (the draft made it required); the notification `_meta` shape types the `io.modelcontextprotocol/subscriptionId` key. 2025-era parsing is unchanged.
    - The error code `-32001` emitted for HTTP header/body mismatches is now defined by the draft schema (`HEADER_MISMATCH`); the emitted behavior is unchanged (documentation only).

    No public API surface changes; the regenerated reference artifacts are internal/test-only.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Test-only hardening, no runtime changes: a spec example corpus harness (the draft revision's 86 example directories vendored from the specification repository plus a frozen hand-built 2025-11-25 corpus, with rejection-side fixtures routed through real dispatch), a cross-bundle typed-error recognition guard, and extended end-to-end draft-vocabulary leak coverage for hosted transports, SSE streams, and compatibility fallback paths.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Internal: regenerate the 2026-07-28 spec reference types from the latest draft schema (`DiscoverResult` now extends `CacheableResult`; `ElicitationCompleteNotificationParams` extracted as a named interface) and document the anchor lifecycle policy. Released-revision spec-type generation is now pinned to a fixed spec commit; draft anchors keep floating via the nightly refresh PRs. No public API or runtime behavior changes.

- [#2286](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) [`1823aae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1823aae891837ebb5e3db885ec635f9efefd5771) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Freeze the per-era wire schemas as self-contained copies decoupled from the public types layer, and convert `WireCodec` to a function-only interface. Two small spec-conformance fixes ride along with the otherwise-pure refactor:
    - The 2026 wire-true `resultType` member now defaults to `'complete'` when absent (the spec's receiver-side back-compat rule); the inbound `decodeResult` step continues to require it. The `server/discover` result accepts absent or malformed `ttlMs`/`cacheScope` (falling back to `0`/`'private'` per the spec's receiver leniency in caching.mdx) so the version-negotiation probe classifier stays behavior-neutral. Other cacheable result schemas are unchanged here; general receiver leniency for those belongs to the response-cache surface.
    - The sampling `hasTools` discriminant now keys on `tools || toolChoice` (previously `tools` only), aligning the client and server selection of the with-tools result variant with `clientCapabilityRequirements`.

## 2.0.0-alpha.2

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

- [#2248](https://github.com/modelcontextprotocol/typescript-sdk/pull/2248) [`db28156`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db28156a23032290b3ce3bae00a17544c4807b8f) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Restore the 2025-11-25
  task wire types that were removed together with the task feature: the task schemas and inferred types, task members of the request/result/notification unions, the `task` request-params augmentation, the `tasks` capability key, the `isTaskAugmentedRequestParams` guard, and
  `RELATED_TASK_META_KEY`. The task feature itself remains removed — servers do not advertise the `tasks` capability and inbound `tasks/*` requests receive `-32601` — but the wire surface stays so SDKs interoperate cleanly with peers on the 2025-11-25 revision.

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

### Patch Changes

- [#1901](https://github.com/modelcontextprotocol/typescript-sdk/pull/1901) [`e15a8ef`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e15a8ef3be19520d8159ae9f5b464ba3ac80a5ab) Thanks [@felixweinberger](https://github.com/felixweinberger)! -
  `registerTool`/`registerPrompt` accept a raw Zod shape (`{ field: z.string() }`) for `inputSchema`/`outputSchema`/`argsSchema` in addition to a wrapped Standard Schema. Raw shapes are auto-wrapped with `z.object()`. The raw-shape overloads are `@deprecated`; prefer wrapping
  with `z.object()`.

    Also widens the `completable()` constraint from `StandardSchemaWithJSON` to `StandardSchemaV1` so v1's `completable(z.string(), fn)` continues to work.

- [#2268](https://github.com/modelcontextprotocol/typescript-sdk/pull/2268) [`49c0a71`](https://github.com/modelcontextprotocol/typescript-sdk/commit/49c0a711c8bf2d385f9e03b4f28ba0ff0d0db0bd) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Mark the roots, sampling, and
  logging runtime APIs as `@deprecated` per SEP-2577 (deprecated as of protocol version 2026-07-28; functional for at least twelve months). Annotates `Server.createMessage`/`listRoots`/`sendLoggingMessage`, `McpServer.sendLoggingMessage`,
  `Client.setLoggingLevel`/`sendRootsListChanged`, the `ServerContext.mcpReq.log`/`requestSampling` helpers, and the `roots`/`sampling`/`logging` capability schema fields. JSDoc/docs only — no behavior change.

- [#2270](https://github.com/modelcontextprotocol/typescript-sdk/pull/2270) [`78fbe27`](https://github.com/modelcontextprotocol/typescript-sdk/commit/78fbe2736d72be4841072b359b3a2b8c6f97cd5c) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Add reserved trace context
  `_meta` key constants (`TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, `BAGGAGE_META_KEY`) per SEP-414, plus docs and a passthrough regression test. The spec reserves the unprefixed `_meta` keys `traceparent`, `tracestate`, and `baggage` (W3C Trace Context / W3C Baggage formats)
  for distributed tracing; the SDK passes them through untouched.

- [#2252](https://github.com/modelcontextprotocol/typescript-sdk/pull/2252) [`8d55531`](https://github.com/modelcontextprotocol/typescript-sdk/commit/8d55531dabd5aa2de8864d691520cd6c6fe77541) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add per-revision spec
  reference types (2025-11-25 and 2026-07-28) with split comparison tests, and the 2026-07-28 wire contract surface: request-meta key constants, `RequestMetaEnvelopeSchema`, `server/discover` shapes, the typed `-32004` error, the `-32003` code constant, and a `resultType`
  passthrough on the base result. Types and constants only — no behavior changes.

- [#2275](https://github.com/modelcontextprotocol/typescript-sdk/pull/2275) [`1b53a41`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b53a415ea2c33aa11ac413fc9c2d68ccffde784) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add a configurable
  `maxBufferSize` (default 10 MB) to the stdio transports. When a single message would push the read buffer past the limit, the transport now emits an `onerror` and closes instead of growing the buffer unbounded. Configure via `new StdioClientTransport({ ..., maxBufferSize })` or
  `new StdioServerTransport(stdin, stdout, { maxBufferSize })`. The default is exported from `@modelcontextprotocol/core-internal` as `STDIO_DEFAULT_MAX_BUFFER_SIZE`.

- [#1976](https://github.com/modelcontextprotocol/typescript-sdk/pull/1976) [`55b1f06`](https://github.com/modelcontextprotocol/typescript-sdk/commit/55b1f06cd4569e334f3435b7971f0446f1ef9be9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - refactor: subclasses
  override `_wrapHandler` hook instead of redeclaring `setRequestHandler`.

- [#1768](https://github.com/modelcontextprotocol/typescript-sdk/pull/1768) [`866c08d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/866c08d3640c5213f80c3b4220e24c42acfc2db8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Allow additional JSON
  Schema properties in elicitInput's requestedSchema type by adding .catchall(z.unknown()), matching the pattern used by inputSchema. This fixes type incompatibility when using Zod v4's .toJSONSchema() output which includes extra properties like $schema and additionalProperties.

- [#1895](https://github.com/modelcontextprotocol/typescript-sdk/pull/1895) [`b256546`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b256546750277faeb7c886792aae5ed26e6904d5) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fix runtime crash on
  `tools/list` when a tool's `inputSchema` comes from zod 4.0–4.1. The SDK requires `~standard.jsonSchema` (StandardJSONSchemaV1, added in zod 4.2.0); previously a missing `jsonSchema` crashed at `undefined[io]`. `standardSchemaToJsonSchema` now detects zod 4 schemas lacking
  `jsonSchema` and falls back to the SDK-bundled `z.toJSONSchema()`, emitting a one-time console warning. zod 3 schemas (which the bundled zod 4 converter cannot introspect) and non-zod schema libraries without `jsonSchema` get a clear error pointing to `fromJsonSchema()`. The
  workspace zod catalog is also bumped to `^4.2.0`.

## 2.0.0-alpha.1

### Minor Changes

- [#1673](https://github.com/modelcontextprotocol/typescript-sdk/pull/1673) [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - refactor: extract task
  orchestration from Protocol into TaskManager

    **Breaking changes:**
    - `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

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
    import { fromJsonSchema, AjvJsonSchemaValidator } from '@modelcontextprotocol/core-internal';

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

- [#1735](https://github.com/modelcontextprotocol/typescript-sdk/pull/1735) [`a2e5037`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a2e503733f6f3eea3a79a80bdc1b3cdd743f8bb3) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Abort in-flight request
  handlers when the connection closes. Previously, request handlers would continue running after the transport disconnected, wasting resources and preventing proper cleanup. Also fixes `InMemoryTransport.close()` firing `onclose` twice on the initiating side.

- [#1574](https://github.com/modelcontextprotocol/typescript-sdk/pull/1574) [`379392d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/379392d04460ee2cbeecae374901fae21e525031) Thanks [@olaservo](https://github.com/olaservo)! - Add missing `size` field to
  `ResourceSchema` to match the MCP specification

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1761](https://github.com/modelcontextprotocol/typescript-sdk/pull/1761) [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Convert remaining
  capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()`, the task capability helpers in `experimental/tasks/helpers.ts`, and the sampling/elicitation capability checks in
  `experimental/tasks/server.ts`.

- [#1790](https://github.com/modelcontextprotocol/typescript-sdk/pull/1790) [`89fb094`](https://github.com/modelcontextprotocol/typescript-sdk/commit/89fb0947b487b37f9bfcc2a2486dcd33d3922f8e) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Consolidate per-request
  cleanup in `_requestWithSchema` into a single `.finally()` block. This fixes an abort signal listener leak (listeners accumulated when a caller reused one `AbortSignal` across requests) and two cases where `_responseHandlers` entries leaked on send-failure paths.

- [#1486](https://github.com/modelcontextprotocol/typescript-sdk/pull/1486) [`65bbcea`](https://github.com/modelcontextprotocol/typescript-sdk/commit/65bbceab773277f056a9d3e385e7e7d8cef54f9b) Thanks [@localden](https://github.com/localden)! - Fix InMemoryTaskStore to enforce
  session isolation. Previously, sessionId was accepted but ignored on all TaskStore methods, allowing any session to enumerate, read, and mutate tasks created by other sessions. The store now persists sessionId at creation time and enforces ownership on all reads and writes.

- [#1766](https://github.com/modelcontextprotocol/typescript-sdk/pull/1766) [`48aba0d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/48aba0d3c3b2ee04c442934095b663d19e07a3b3) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add explicit
  `| undefined` to optional properties on the `Transport` interface and `TransportSendOptions` (`onclose`, `onerror`, `onmessage`, `sessionId`, `setProtocolVersion`, `setSupportedProtocolVersions`, `onresumptiontoken`).

    This fixes TS2420 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where the emitted `.d.ts` for implementing classes included `| undefined` but the interface did not.

    Workaround for older SDK versions: enable `skipLibCheck: true` in your tsconfig.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1796](https://github.com/modelcontextprotocol/typescript-sdk/pull/1796) [`d6a02c8`](https://github.com/modelcontextprotocol/typescript-sdk/commit/d6a02c85c0514658c27615398a3003aadce80fb0) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Ensure
  `standardSchemaToJsonSchema` emits `type: "object"` at the root, fixing discriminated-union tool/prompt schemas that previously produced `{oneOf: [...]}` without the MCP-required top-level type. Also throws a clear error when given an explicitly non-object schema (e.g.
  `z.string()`). Fixes #1643.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal

- [#1762](https://github.com/modelcontextprotocol/typescript-sdk/pull/1762) [`64897f7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/64897f78ce78f736b027dfecd1b4326c8c6678c7) Thanks [@felixweinberger](https://github.com/felixweinberger)! -
  `ReadBuffer.readMessage()` now silently skips non-JSON lines instead of throwing `SyntaxError`. This prevents noisy `onerror` callbacks when hot-reload tools (tsx, nodemon) write debug output like "Gracefully restarting..." to stdout. Lines that parse as JSON but fail JSONRPC
  schema validation still throw.
