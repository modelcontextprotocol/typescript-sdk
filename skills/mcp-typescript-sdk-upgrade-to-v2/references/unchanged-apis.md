## Unchanged APIs

The following are unchanged between v1 and v2 apart from the import path — except
where an entry notes its own signature change:

- `Client` constructor and `connect`, `close`, and the typed verbs (`listTools`,
  `listPrompts`, `listResources`, `readResource`, …) — note `callTool()` and `request()`
  signatures changed (schema parameter dropped for spec methods).
- `McpServer` constructor, `server.connect(transport)`, `server.close()`, and the
  `McpServer.server` accessor — still the supported way to call the low-level
  `Server`'s push verbs (`createMessage` / `listRoots` / `sendLoggingMessage` — ⚠
  `@deprecated`, see [§Deprecated in v2](protocol-ctx.md#deprecated-in-v2-sep-2577)) outside a
  handler context.
- The server Streamable HTTP transports' **constructor options** (`sessionIdGenerator`,
  `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`, `eventStore`,
  `retryInterval`) and the `handleRequest` surface — only the class name and import
  moved: `StreamableHTTPServerTransport` is now `NodeStreamableHTTPServerTransport`
  from `@modelcontextprotocol/node`, a thin wrapper over
  `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`,
  which exposes the same options ([decision rule](imports-transports.md#imports--transports)). The
  transport-level `closeSSEStream(requestId)` / `closeStandaloneSSEStream()` methods
  keep their v1 names too — only the handler-context accessors moved to `ctx.http`
  ([remap table](protocol-ctx.md#low-level-protocol--handler-context-ctx)).
- `UriTemplate` (v1: `@modelcontextprotocol/sdk/shared/uriTemplate.js`) — `expand` /
  `match` semantics carry over; import it from `@modelcontextprotocol/server` or
  `@modelcontextprotocol/client` (top-level export; the codemod rewrites the path).
- `StreamableHTTPClientTransport`, `SSEClientTransport` constructors and options —
  including resumability: the per-request `resumptionToken` / `onresumptiontoken`
  request options carry over from v1 unchanged
  ([Resume a dropped stream](https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.md#resume-a-dropped-stream)).
- `StdioClientTransport` and `StdioServerTransport` — **import path moved** to the
  `./stdio` subpath and gained an optional `maxBufferSize` ([Imports & transports](imports-transports.md#imports--transports)).
- The **`Transport` interface contract** — `start` / `send` / `close`, `onmessage` /
  `onclose` / `onerror`, optional `sessionId` and `setProtocolVersion`,
  `TransportSendOptions`, `MessageExtraInfo`. Hand-rolled v1 transports (recording
  wrappers, test doubles, decorators) compile and run against v2 with only the import
  path updated. v2 adds **optional** members only — `hasPerRequestStream` and
  `setSupportedProtocolVersions` on the interface, `requestSignal` / `headers` /
  `onRequestStreamEnd` on `TransportSendOptions` — which matter only for 2026-era
  per-request-stream cancellation and `Mcp-Param-*` header attachment
  ([support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md)).
- All TypeScript **type** definitions from `types.ts` (except the aliases listed under
  [Removed type aliases](types-schemas.md#removed-type-aliases) and the `experimental` capability
  payload narrowing — see [Types & schemas](types-schemas.md#types--schemas)).
- Tool, prompt, and resource callback return types.

> The `Server` (low-level) constructor and **most** of its methods are unchanged, but
> `setRequestHandler` / `setNotificationHandler` and `request()` signatures changed
> ([Low-level protocol](protocol-ctx.md#low-level-protocol--handler-context-ctx)). In particular,
> `Server.createElicitationCompletionNotifier()` is unchanged — including its
> construction-time client-capability check — for 2025-era URL-mode elicitation
> ([support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md)). The Zod `*Schema`
> constants are **not** part of the unchanged surface — they moved to
> `@modelcontextprotocol/core` ([Types & schemas](types-schemas.md#types--schemas)).
