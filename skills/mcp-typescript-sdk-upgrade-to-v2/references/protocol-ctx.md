### Low-level protocol & handler context (`ctx`)

The second parameter to every request handler — previously the flat `RequestHandlerExtra`
object named `extra` — is now a structured **context** object named `ctx`. This is the
`ctx` that appears throughout the rest of this guide.

The codemod renames the parameter and remaps property access via
[`contextPropertyMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/contextPropertyMap.ts).
A few mappings need optional-chaining adjustment (the `http` group is `undefined` on
stdio):

| v1 (`extra.*`)                                    | v2 (`ctx.*`)                   | Note                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extra.signal`                                    | `ctx.mcpReq.signal`            |                                                                                                                                                                                                                                                                                                                         |
| `extra.requestId`                                 | `ctx.mcpReq.id`                |                                                                                                                                                                                                                                                                                                                         |
| `extra._meta`                                     | `ctx.mcpReq._meta`             |                                                                                                                                                                                                                                                                                                                         |
| `extra.sendRequest(...)`                          | `ctx.mcpReq.send(...)`         |                                                                                                                                                                                                                                                                                                                         |
| `extra.sendNotification(...)`                     | `ctx.mcpReq.notify(...)`       |                                                                                                                                                                                                                                                                                                                         |
| `extra.sessionId`                                 | `ctx.sessionId`                |                                                                                                                                                                                                                                                                                                                         |
| `extra.authInfo`                                  | `ctx.http?.authInfo`           | optional — `undefined` on stdio                                                                                                                                                                                                                                                                                         |
| `extra.requestInfo`                               | `ctx.http?.req`                | a standard Web `Request`; `ServerContext` only                                                                                                                                                                                                                                                                          |
| `extra.closeSSEStream`                            | `ctx.http?.closeSSE`           | `ServerContext` only; the member itself is also optional — defined only when the transport has an `eventStore` AND the client's negotiated protocol version supports resumable close (2025-11-25+); an `eventStore` transport serving a 2025-06-18 client still leaves it `undefined`. Call as `ctx.http?.closeSSE?.()` |
| `extra.closeStandaloneSSEStream`                  | `ctx.http?.closeStandaloneSSE` | `ServerContext` only; member optional as above — `ctx.http?.closeStandaloneSSE?.()`                                                                                                                                                                                                                                     |
| `extra.taskStore` / `taskId` / `taskRequestedTtl` | _removed_                      | see [Experimental tasks](behavioral-changes.md#experimental-tasks-interception-removed)                                                                                                                                                                                                                                 |

The transport-level seam behind `ctx.http?.authInfo` is unchanged from v1: a transport
that passes `{ authInfo }` as the second argument to `onmessage(message, extra)` — e.g.
an `InMemoryTransport` test seam — still surfaces it as `ctx.http?.authInfo` on any
transport, and `ctx.http` is defined whenever `authInfo` is supplied, even without an
HTTP transport.

`BaseContext` is the common base; `ServerContext` and `ClientContext` extend it. None
of the three takes type parameters — v1's `RequestHandlerExtra<TRequest, TNotification>`
arguments selected request/notification unions that the v2 context carries
intrinsically, so their removal loses no type information; review only handlers that
passed custom (non-standard) unions, whose `sendRequest` / `sendNotification` typing
was narrowed by them. `ServerContext.mcpReq` adds convenience methods that replace
calling `server.*` from inside a handler:

| `ctx.mcpReq.*` (new)                           | Replaces (inside a handler)                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.mcpReq.log(level, data, logger?)`         | `server.sendLoggingMessage(...)` — ⚠ **`@deprecated`**, see [§Deprecated in v2](#deprecated-in-v2-sep-2577); the notification also becomes request-related on every era — see [§`ctx.mcpReq.log()` is request-related on every era](behavioral-changes.md#ctxmcpreqlog-is-request-related-on-every-era) |
| `ctx.mcpReq.elicitInput(params, options?)`     | `server.elicitInput(...)`                                                                                                                                                                                                                                                                                |
| `ctx.mcpReq.requestSampling(params, options?)` | `server.createMessage(...)` — ⚠ **`@deprecated`**, see [§Deprecated in v2](#deprecated-in-v2-sep-2577)                                                                                                                                                                                                  |

#### Deprecated in v2 (SEP-2577)

The roots, sampling, and logging subsystems are deprecated as of protocol version
2026-07-28 (SEP-2577). Everything below is **still fully functional in v2** and marked
`@deprecated` for removal in a later major; on a 2026-07-28 connection prefer the
[multi-round-trip `input_required` pattern](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#multi-round-trip-requests)
instead.

- **Runtime APIs**: `Server.createMessage` / `listRoots` / `sendLoggingMessage`,
  `McpServer.sendLoggingMessage`, `Client.setLoggingLevel` / `sendRootsListChanged`, and
  the `ctx.mcpReq.log` / `ctx.mcpReq.requestSampling` handler-context helpers. Outside a
  handler, `McpServer` users reach the `Server.*` methods via the unchanged
  [`mcpServer.server` accessor](unchanged-apis.md#unchanged-apis).
- **Capability fields**: the `roots`, `sampling`, and `logging` capability schema fields.
- **Type stacks**: the full Logging stack (`LoggingLevel`, `SetLevelRequest`,
  `LoggingMessageNotification` and params), the full Sampling stack
  (`CreateMessageRequest`/`Result`, `SamplingMessage`, `ModelPreferences`/`ModelHint`,
  `ToolChoice`, `ToolUseContent`/`ToolResultContent`, the `includeContext` enum values),
  and the full Roots stack (`Root`, `ListRootsRequest`/`Result`,
  `RootsListChangedNotification`).
- **`registerClient`** (Dynamic Client Registration) — deprecated via spec PR
  [modelcontextprotocol#2858](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2858)
  rather than SEP-2577 (listed here because the `@deprecated` annotations landed in
  the same sweep); prefer Client ID Metadata Documents per SEP-991.

The deprecation is annotation-only — JSDoc `@deprecated` markers were added, nothing
else: every deprecated runtime API keeps its v1 call signature (e.g.
`Server.sendLoggingMessage(params, sessionId?)` keeps the two-argument form) and its
wire behavior, and remains functional for at least the twelve-month deprecation window.

#### `setRequestHandler` / `setNotificationHandler` use method strings

The low-level handler registration takes a **method string** instead of a Zod schema.
The codemod rewrites every spec-method registration via
[`schemaToMethodMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts).

```typescript
// v1
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => { ... });
// v2
server.setRequestHandler('tools/call', async (request, ctx) => { ... });
```

**Custom (non-spec) methods** use the 3-arg form `(method, { params, result? }, handler)`
where `params` and `result` are any [Standard Schema](https://standardschema.dev). The
handler receives the parsed `params` directly (not the full request envelope); `_meta`
is at `ctx.mcpReq._meta`. The 3-arg notification handler is `(params, notification) => void`.

```typescript
server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => { ... });
```

The custom form also covers **spec method names carried with custom payloads**: a v1
integration that reused a spec method string for its own payload shape (e.g.
`notifications/message` notifications carrying a proprietary params object) registers
it with the 3-arg form and its own schema. The overloads are selected by the arguments'
shape, not by the method name — a schemas object as the second argument always selects
the custom form, which validates against **your** schema (the spec schema is not
applied) and hands the handler the parsed params rather than the envelope.

**Spec notifications** use the 2-arg form `setNotificationHandler(method, handler)`.
Unlike the 3-arg custom form, the spec-form handler receives the **full notification
envelope** (`{ method, params }`), parsed against the spec schema — read
`notification.params`:

```typescript
client.setNotificationHandler('notifications/tools/list_changed', async notification => {
    console.log(notification.method, notification.params);
});
```

The two overloads are selected by the method string's **type**: the spec form binds the
method to the `NotificationMethod` union (`RequestMethod` on the request side — both
exported), so a method string computed at runtime must be typed as `NotificationMethod`
to select it; an untyped `string` lands on the custom-schema overload and fails to
compile without a schemas argument. `Parameters<Client['setNotificationHandler']>[0]`
also resolves to the custom `string` overload by design — name `NotificationMethod`
directly instead. The request side has the same trap one slot over:
`Parameters<Client['setRequestHandler']>` (and `typeof`-indexed casts over the overload
set) resolve against the 3-arg custom-method overload, so index `[1]` is the
`{ params, result }` schemas object, **not** the handler — v1 signature-erasing handler
casts derived positionally change meaning with no runtime symptom. Name the exported
types (`RequestMethod` and your own handler/param types) instead of deriving them
positionally. Generic helpers that v1 parameterized on a notification schema need
this conversion by hand; the codemod only warns on them.

**Handler returns are spec-typed.** In v1 the handler's return type flowed from the
schema you registered; v2 types it from the method name (`'tools/list'` →
`ListToolsResult`, and so on). Tool tables kept as plain object literals surface two
recurring compile errors: an unannotated literal widens `type: 'object'` to `string`
and no longer satisfies the spec type's `type: 'object'` literal member (fix:
`type: 'object' as const`, or annotate the table as `Tool[]`); and a heterogeneous
table whose inferred union carries `prop?: undefined` members does not satisfy the spec
types' `Record<string, JSONValue>` index signatures, since `undefined` is not a
`JSONValue` (fix: annotate the handler's return type —
`async (req): Promise<ListToolsResult> => …` — or the table itself, so each literal is
checked against the target type instead of being inferred and widened first).

#### `request()`, `ctx.mcpReq.send()`, and `callTool()` no longer require a schema for spec methods

For **spec** methods, drop the result-schema argument; the SDK resolves it from the
method name. The codemod drops it from `client.request()` and `client.callTool()`; drop
it from `ctx.mcpReq.send()` by hand.

```typescript
// v1
import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const r = await extra.sendRequest({ method: 'sampling/createMessage', params: { ... } }, CreateMessageResultSchema);
    return { content: [{ type: 'text', text: 'done' }] };
});

// v2
server.setRequestHandler('tools/call', async (request, ctx) => {
    const r = await ctx.mcpReq.send({ method: 'sampling/createMessage', params: { ... } });
    return { content: [{ type: 'text', text: 'done' }] };
});
```

For **custom (non-spec)** methods, keep the result-schema argument:
`await client.request({ method: 'acme/search', params }, SearchResult)` — only drop the
schema when calling a spec method.

**Forwarding arbitrary methods (gateways / proxies).** Dropping the schema changes
semantics, not just the signature: a schema-less spec-method call now **enforces** the
spec result schema (a non-conforming upstream result is rejected locally with
`SdkError(SdkErrorCode.InvalidResult)` and a conforming one is re-serialized in schema
key order), and a schema-less call for a **non-spec** method throws a `TypeError` at
the call site (`'…' is not a spec method; pass a result schema`).
A relay that forwards `{ method, params }` it does not understand must keep passing an
explicit result schema. The v1 idiom survives with an import-path change:

```typescript
import { ResultSchema } from '@modelcontextprotocol/core';
const result = await upstream.request({ method, params }, ResultSchema); // v1-identical passthrough
```

For byte-exact forwarding (member order preserved), pass your own accept-anything
Standard Schema instead. Check call sites whose `method` is **not a literal** — the
codemod may have dropped the schema argument there; restore it.

The **inbound half** — a relay re-emitting an upstream JSON-RPC error from its own
handler — has a supported surface too: reconstruct the typed error with
`ProtocolError.fromError(code, message, data)` and throw it; the encode seam serializes
it back to the wire shape (see [Typed `ProtocolError` subclasses](errors.md#typed-protocolerror-subclasses)).
Note this is typed reconstruction, not byte-exact relay: legacy codes are normalized at
the encode seam (`-32002` re-emits as `-32602`) and the typed subclasses keep only their
schema-defined `data` members, so extra upstream data keys are dropped. Throwing a plain
object carrying `.code` / `.message` / `.data` happens to work today, but it is
unspecified behavior — prefer `fromError`.

The return type is inferred from the method name via `ResultTypeMap` (e.g.
`client.request({ method: 'tools/call', ... })` returns `Promise<CallToolResult>`).
v1 call sites that passed `CreateMessageResultWithToolsSchema` explicitly need no
replacement: the schema-less send resolves to
`CreateMessageResult | CreateMessageResultWithTools`, and validation selects the
with-tools variant when the request set `tools` or `toolChoice`.
