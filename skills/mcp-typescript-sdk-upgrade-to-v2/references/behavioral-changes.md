### Behavioral changes

These are runtime-behavior changes that may affect tests and assertions; no source
rewrite required unless noted.

#### Error-shape changes (every era)

- **Unchanged, for re-baselining relief:** timeout rejections still carry
  `data.timeout` / `data.maxTotalTimeout` exactly as v1 `McpError` did — v1 assertions
  on those survive verbatim. The cancelled-on-timeout signal is unchanged on legacy-era
  connections and on stdio/in-memory at any era; on 2026-era Streamable HTTP the cancel
  signal is the per-request stream close instead of a `notifications/cancelled` POST
  (see [support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md)). The one exemption is the
  `initialize` handshake: an aborted or timed-out `connect()` still rejects locally, but
  no `notifications/cancelled` goes on the wire — the spec forbids cancelling
  `initialize`, and v1 sent one anyway. v1 tests asserting that notification need
  re-baselining.
- **Also unchanged: SSE reconnection exhaustion.** `StreamableHTTPClientTransport`'s
  standalone GET-stream reconnection behavior and its exhaustion signal carry over from
  v1: when retries run out, the transport emits `onerror` with a plain `Error` whose
  message is `Maximum reconnection attempts (N) exceeded.` — there is no typed error
  class for this condition, so monitors that match the message text keep working.
- **Also unchanged: elicitation response validation.** `elicitInput`'s local validation
  of elicitation responses against `requestedSchema`, the resulting `-32602` error
  message wording (`Elicitation response content does not match requested schema: …`),
  and the `McpServer` / `Client` `jsonSchemaValidator` option carry over from v1 —
  tests pinning the local-validation message and custom validator wiring need no
  re-baselining.
- **Unknown / disabled tool calls now reject** with `ProtocolError(-32602 InvalidParams)`
  instead of resolving `CallToolResult{isError: true}`. v1 callers that checked
  `result.isError` for an unknown tool will get an unhandled rejection — catch the
  rejected promise instead.
- **The `MCP error <code>: ` message prefix is gone.** v1 prefixed relayed JSON-RPC
  error messages (`MCP error -32602: …`); v2's `ProtocolError.message` carries the
  peer's message verbatim. Tests and log scrapers that matched the prefix or the numeric
  code in rendered text should match `error.code` instead.
- **In-flight request handlers are aborted on transport close** — `ctx.mcpReq.signal`
  fires (v1 let them run to completion). `InMemoryTransport.close()` no longer
  double-fires `onclose` on the initiating side.
- **`Protocol.request()` with an already-aborted signal** rejects with
  `SdkError(SdkErrorCode.RequestTimeout, reason)` instead of throwing the raw
  `signal.reason`, matching the in-flight-abort path.
- **OAuth discovery (`discoverOAuthProtectedResourceMetadata` / `discoverOAuthMetadata`,
  transitively `auth()`) throws on fetch `TypeError`** (DNS failure, `ECONNREFUSED`,
  invalid URL) in Node and Cloudflare Workers instead of swallowing it as a CORS miss
  → `undefined`. The CORS-swallow remains browser-only.

#### Client connection & dispatch

- **`connect()` skips the `initialize` handshake when the transport already exposes a
  `sessionId`** — it assumes it is reconnecting to an existing session (unchanged from
  v1.x, where the same guard has existed since 1.10.0; recorded here because the
  far-away symptom keeps surprising migrators). A custom or test transport that sets `sessionId` at construction
  silently skips initialization: `getServerCapabilities()` stays `undefined` and the
  list verbs return empty results. Expose `sessionId` only after the first request has
  been sent.
- **The typed verbs dispatch after async pre-work.** `Protocol.request()` itself still
  hands the frame to the transport before its first `await` (v1-compatible). The typed
  verbs on top of it — `callTool()` and the cacheable list verbs — perform async work
  first (header-mirroring scan, response-cache freshness, output-validator resolution),
  so an abort fired in the same tick can land before the frame is ever sent: the call
  rejects with `SdkError(RequestTimeout, reason)` and **no `notifications/cancelled` is
  emitted** (nothing was in flight). v1 sent the frame synchronously from these verbs.
  Once the frame is on the wire, aborting still sends `notifications/cancelled` before
  rejecting.
- **Protocol-version pinning is a first-class option.**
  `ProtocolOptions.supportedProtocolVersions` pins the legacy `initialize` handshake:
  the **first** pre-2026 entry in the list is offered (list order is preference order),
  a counter-offer is accepted only if it is one of the list's pre-2026 entries, and a
  list with no pre-2026 entry makes the handshake throw. Under
  `versionNegotiation: 'auto'` the modern probe candidates are the list's modern
  entries when it has any (otherwise the SDK's default modern set); a `{ pin }` is
  honored as given and is not checked against the list (see
  [support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#client-side-versionnegotiation)).
  v1 had no public equivalent (`SUPPORTED_PROTOCOL_VERSIONS` was a fixed constant) —
  replace any workaround that patched the offered version with this option.
- **Also unchanged: HTTP 405 tolerances.** A `405` answering the standalone GET stream
  open is benign (the client proceeds without the stream), and a `405` answering the
  session DELETE resolves `terminateSession()` normally — stateless-topology servers
  that decline both verbs keep working without changes, as in v1.

#### stdio transport

- A configurable `maxBufferSize` (default **10 MB**) caps the stdio read buffer. A
  single message that would push the buffer past the limit emits `onerror` and
  **closes the connection** (v1 buffered unbounded). Configure via
  `new StdioClientTransport({ ..., maxBufferSize })` /
  `new StdioServerTransport(stdin, stdout, { maxBufferSize })`.
- `ReadBuffer.readMessage()` now **silently skips non-JSON stdout lines** instead of
  throwing `SyntaxError` → `onerror`. Hot-reload tools (tsx, nodemon) that write debug
  output to stdout no longer break the transport. Lines that parse as JSON but fail
  JSON-RPC schema validation still throw.
- `StdioClientTransport` always sets `windowsHide: true` when spawning the server
  process on Windows (previously Electron-only). Prevents stray console windows in
  non-Electron Windows hosts.
- Outbound write failures — e.g. the host closing the stdout pipe while a send is
  pending — now reject the pending `send()` and close the transport through
  `onerror`/`onclose` instead of surfacing an unhandled stream error; lifecycle
  tests that pinned a crash-class exit observe a clean shutdown instead.

#### Client list methods

- `listPrompts()`, `listResources()`, `listResourceTemplates()`, `listTools()` return
  **empty results** when the server didn't advertise the corresponding capability,
  instead of sending the request. Set `enforceStrictCapabilities: true` in `ClientOptions`
  to restore the v1 throw.
- Called **without a `cursor`**, the same methods now **auto-aggregate every page** and
  return an aggregate with no `nextCursor`. Passing `{ cursor }` still fetches one page. Manual
  pagination loops keep working (the first iteration returns everything); replace them
  with the bare no-arg call. The walk is capped at `ClientOptions.listMaxPages` (default
  64); overrun throws `SdkError(ListPaginationExceeded)`. There is no way to fetch only
  the **first** page through the typed verbs — for page-level observation
  (pagination tooling, per-page stats) drop to
  `client.request({ method: 'tools/list', params })`, which never aggregates.
- Output-schema validator compilation is now **lazy** — validators compile on the first
  `callTool()` against the cached `tools/list` entry, not eagerly inside `listTools()`.
  In v1, `listTools()` threw on an uncompilable `outputSchema`; now `listTools()`
  succeeds and the compile failure surfaces when `callTool()` is invoked on the affected
  tool, as `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")`,
  before the request is sent. Validation is never silently skipped.
- On a 2026-07-28 connection the cacheable verbs honour the server-stamped `ttlMs` /
  `cacheScope` (SEP-2549) and may return a still-fresh cached entry without a round
  trip. Per-call override: `{ cacheMode: 'refresh' | 'bypass' }`. New `ClientOptions`:
  `cachePartition`, `defaultCacheTtlMs`. `ResponseCacheStore` gained `delete(key)`;
  `InMemoryResponseCacheStore` is now bounded (`{ maxEntries }`, default 512).
  `CacheEntry.value` (and the `set()` entry value) is the JSON-serialized result
  document (`string`, not `unknown`): persist and return it verbatim, `JSON.parse`
  it to inspect.

#### Server (Streamable HTTP transport)

- Resumability behavior (SSE priming events, `closeSSE` / `closeStandaloneSSE`
  callbacks) is only enabled for protocol versions in the transport's supported-versions
  list that are `>= 2025-11-25`. Unknown future version strings in an `initialize`
  request body no longer enable it.
- Session-ID mismatch still responds `404` with JSON-RPC `-32001` (`Session not found`),
  unchanged from v1. This `-32001` is an SDK convention, not spec-assigned; client code
  should key off the HTTP `404` status, not `-32001`.

#### Server (deprecated accessors and app-factory Origin validation)

- `Server.getClientCapabilities()`, `getClientVersion()`, `getNegotiatedProtocolVersion()`
  are `@deprecated` but functional. On 2026-07-28 requests, prefer `ctx.mcpReq.envelope`.
- `createMcpExpressApp()` / `createMcpHonoApp()` / `createMcpFastifyApp()` with a
  localhost-class `host` now also validate the `Origin` header by default. Browser-served
  clients on a non-localhost origin need `allowedOrigins: [...]` (replaces the default
  localhost allowlist; validation cannot be disabled for localhost binds). Requests
  without an `Origin` header are unaffected; a present `Origin` that cannot be parsed
  — including the opaque **`Origin: null`** sent by sandboxed iframes, `file://` pages,
  and cross-origin redirects — is **rejected with 403** and cannot be allowlisted via
  `allowedOrigins`. Framework-agnostic helpers
  (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`) are in
  `@modelcontextprotocol/server`; `@modelcontextprotocol/node` ships
  `hostHeaderValidation` / `originValidation` request guards for plain `node:http`.

#### Server (McpServer / Streamable HTTP behavior)

- **Eager capability-handler install.** `McpServer` now installs list/read/call handlers
  for every primitive capability declared in `ServerOptions.capabilities`, even with
  zero registrations. `new McpServer(info, { capabilities: { tools: {} } })` with no
  registered tools answers `tools/list` with `{ tools: [] }` instead of `-32601 Method
not found`. Low-level `Server` users remain responsible for registering handlers for
  declared capabilities — with one exception: declaring the `logging` capability (in
  the constructor's capabilities or via pre-connect `registerCapabilities()`) installs
  the `logging/setLevel` handler on the low-level `Server` too, so `logging/setLevel`
  requests that answered `-32601` in v1 now resolve. Eager install also rewrites the **advertised** capability
  objects: a declared `tools: {}` / `resources: {}` / `prompts: {}` is advertised with
  `listChanged: true` at construction, so capability pins and initialize-result golden
  tests need re-baselining. To advertise without the default, set
  `listChanged: false` explicitly; capabilities declared on the low-level `Server` are
  advertised verbatim.
- **`WebStandardStreamableHTTPServerTransport` store-first `eventStore` semantics.**
  Request-related events emitted after `closeSSE()` — and the final response when no
  per-request stream is connected — are now persisted to the configured `eventStore` for
  replay (v1 dropped them / threw `"No connection established"`). Without an
  `eventStore`, the same condition surfaces via `onerror` and the request id is retired.
  `NodeStreamableHTTPServerTransport` is a thin wrapper over
  `WebStandardStreamableHTTPServerTransport`, so this — like every behavioral note on
  the web-standard transport — applies to the Node transport too.
- **`registerResource` reserves the `cacheHint` config key.** It is validated
  (`RangeError` on invalid values) and stripped from the resource's list metadata; v1
  passed it through verbatim as ordinary metadata. Untyped callers that previously
  smuggled a `cacheHint` key through resource metadata should rename it.

#### `ctx.mcpReq.log()` is request-related on every era

`ctx.mcpReq.log()` now emits its `notifications/message` request-related (it rides the
in-flight exchange like progress) on every era. On a 2025-era sessionful Streamable HTTP
transport this moves handler-emitted logs from the standalone GET stream onto the
per-request POST response stream — a spec-conformance correction. The session-scoped
`logging/setLevel` filter applies as before on 2025-era connections. (On 2026-07-28
requests, the per-request `_meta.logLevel` envelope key is the filter — see
[support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#serving-the-2026-07-28-revision).)

#### Wire tightening (every era)

- **`CallToolResult.content` keeps the v1 parse tolerance on the legacy era.** An
  inbound result without `content` defaults to `[]` (deployed servers omit it
  alongside `structuredContent`); 2026-07-28 connections stay strict. Authoring is
  unchanged and era-independent: the TypeScript surface requires `content` on handler
  results, and a content-less handler result is normalized to `content: []` before it
  reaches the wire. One sharpening remains: a content-less body carrying another
  result family's vocabulary (a task handle or an `input_required` round) is still
  rejected loudly — tolerance never turns a different result kind into a silent empty
  success. A body whose only foreign key was `resultType` strips to an empty object
  and defaults, exactly as v1 parsed a payload-free body.
- **`ElicitResult.content` values are typed and validated as
  `string | number | boolean | string[]`.** v1's TypeScript surface accepted
  `Record<string, unknown>` content values; an elicitation handler returning arbitrary
  objects now fails to compile (and fails schema validation) — narrow to the primitives
  the elicitation spec allows.
- **Custom (3-arg) handlers receive `_meta`.** `setRequestHandler(method, {params}, handler)`
  used to delete `params._meta` before validation; it now passes `_meta` through (minus
  the reserved `io.modelcontextprotocol/*` envelope keys). If your params schema is
  strict, add an optional `_meta` member.
- **`specTypeSchemas` validate the neutral model.** Result entries no longer accept
  `resultType`; the validators for the 2025-only task message types and
  `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed accordingly).
- **Sampling `hasTools` discriminant** now keys on `tools || toolChoice` (previously
  `tools` only) when selecting the with-tools `CreateMessageResult` variant, on every
  era.
- **Inbound frames that fail message-shape validation are not answered.** v2 routes
  every inbound frame through typed message guards; a frame that matches no JSON-RPC
  shape (e.g. a hand-built ping with an explicitly-`undefined` `id`, or non-object
  `params`) is dropped and surfaces only via `onerror` (`Unknown message type: …`) — no
  response is sent. v1-era test fences that await a reply to a hand-written raw frame
  hang instead of resolving; send through the typed surface (`client.ping()`,
  `client.request()`) instead.

#### Experimental tasks interception removed

The 2025-11 task side-channel through `Protocol` is removed (was always `@experimental`).
No mechanical migration; remove usages. Gone: `ProtocolOptions.tasks`,
`protocol.taskManager`, `RequestOptions.task` / `relatedTask`, `BaseContext.task`,
`assertTaskCapability` / `assertTaskHandlerCapability`, `*.experimental.tasks.*`
accessors and `Experimental{Client,Server,McpServer}Tasks`, `requestStream` /
`callToolStream` / `createMessageStream` / `elicitInputStream` and the `ResponseMessage`
types they yielded, `registerToolTask`, `ToolTaskHandler`, `TaskRequestHandler`,
`CreateTaskRequestHandler`, `TaskMessageQueue`, `InMemoryTaskMessageQueue`,
`BaseQueuedMessage` / `Queued*`, `CreateTaskServerContext`, `TaskServerContext`,
`TaskToolExecution`, `TaskStore`, `InMemoryTaskStore`, `CreateTaskOptions`, `isTerminal`,
and the `new McpServer(info, { taskStore, taskMessageQueue })` constructor option keys
(the codemod emits an action-required diagnostic at each — remove the option).

The task **wire types** remain importable as `@deprecated` vocabulary for 2025-11-25
interop — see [support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#tasks-deprecated-wire-vocabulary).

#### Specification clarifications adopted (no SDK behavior change)

The 2026-07-28 specification revision includes a number of documentation-only
clarifications recorded here so an audit of the revision's changelog against this guide
is complete; nothing in this list requires code changes: per-operation timeout guidance
removal (`RequestOptions.timeout` / `DEFAULT_REQUEST_TIMEOUT_MSEC` unchanged); stdio
shutdown wording; transports-as-bindings reframe; `resources/read` wording (the
`file://` path-sanitization MUST is server-author guidance — your handler must reject
traversal / symlink escapes itself); `PromptMessage` resource links (already in
`ContentBlock`); completion `ref/resource` URI templates; pagination empty-string
cursors (already passed through verbatim); sampling host-requirement docs; elicitation
statefulness wording; cosmetic schema/JSDoc sweeps.
