### Errors

The SDK now distinguishes three error kinds:

1. **`ProtocolError`** (renamed from `McpError`) — protocol errors that cross the wire
   as JSON-RPC error responses. Uses `ProtocolErrorCode` (renamed from `ErrorCode`).
2. **`SdkError`** — local SDK errors that never cross the wire. Uses `SdkErrorCode`.
3. **`SdkHttpError`** (extends `SdkError`) — HTTP transport errors with typed `.status`
   and `.statusText`.

These classes (and `OAuthError`, the client's `SseError`, `UnauthorizedError`, and the
OAuth-client-flow error family) brand-match under `instanceof`, so checks work across
separately bundled copies of the SDK — e.g. a process using both
`@modelcontextprotocol/client` and `@modelcontextprotocol/server`. Each branded
hierarchy also exposes the same check as an explicit static guard
(`SdkError.isInstance(err)`, `ProtocolError.isInstance(err)`, …) that narrows in
TypeScript — use whichever style your codebase prefers; both read the same brand.
Fine print (applies equally to `instanceof` and `isInstance`):

- **Version skew** — matching needs _both_ copies at a brand-aware release; against an
  older copy, behavior degrades to plain prototype `instanceof` (false across bundles).
  During mixed-version rollouts, recognize errors without class identity: match
  `error.name` plus the class's discriminant field (`code`, `status`), or reconstruct
  typed protocol errors with `ProtocolError.fromError(code, message, data)`.
- **Worker boundaries** — `structuredClone`/`postMessage` drop the (symbol-keyed) brand,
  so a rehydrated error no longer brand-matches; recognize forwarded errors by
  `code`/`data` instead.
- **Brands assert identity, not shape** — a matched instance from another SDK version
  may lack newer fields; read fields defensively.
- **Re-bundling with property mangling** (`mangle.props` and similar) breaks the brand
  statics; default esbuild/webpack/terser settings are safe.

The codemod renames `McpError` → `ProtocolError`, `ErrorCode` → `ProtocolErrorCode`
(routing `RequestTimeout` / `ConnectionClosed` to `SdkErrorCode`), and
`StreamableHTTPError` → `SdkHttpError`. After the codemod runs, your `instanceof`
checks already name the v2 classes — what's left is choosing which `SdkErrorCode` /
class to match per scenario:

| Scenario                                         | v1                                        | v2                                                                 |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| Request timeout                                  | `McpError` + `ErrorCode.RequestTimeout`   | `SdkError` + `SdkErrorCode.RequestTimeout`                         |
| Connection closed                                | `McpError` + `ErrorCode.ConnectionClosed` | `SdkError` + `SdkErrorCode.ConnectionClosed`                       |
| Capability not supported                         | `new Error(...)`                          | `SdkError` + `SdkErrorCode.CapabilityNotSupported`                 |
| Not connected                                    | `new Error('Not connected')`              | `SdkError` + `SdkErrorCode.NotConnected`                           |
| Response result fails schema                     | raw `ZodError`                            | `SdkError` + `SdkErrorCode.InvalidResult`                          |
| Invalid params (server response)                 | `McpError` + `ErrorCode.InvalidParams`    | `ProtocolError` + `ProtocolErrorCode.InvalidParams`                |
| HTTP transport error                             | `StreamableHTTPError`                     | `SdkHttpError` + `SdkErrorCode.ClientHttp*`                        |
| Failed to open SSE stream                        | `StreamableHTTPError`                     | `SdkHttpError` + `SdkErrorCode.ClientHttpFailedToOpenStream`       |
| 401 after re-auth (circuit break)                | `StreamableHTTPError`                     | `SdkHttpError` + `SdkErrorCode.ClientHttpAuthentication`           |
| `SSEClientTransport.send()` 401 after re-auth    | `UnauthorizedError`                       | `SdkHttpError` + `SdkErrorCode.ClientHttpAuthentication`           |
| 403 `insufficient_scope` after step-up retry cap | `StreamableHTTPError`                     | `SdkHttpError` + `SdkErrorCode.ClientHttpForbidden`                |
| Unexpected content type                          | `StreamableHTTPError`                     | `SdkError` + `SdkErrorCode.ClientHttpUnexpectedContent`            |
| Session termination failed                       | `StreamableHTTPError`                     | `SdkHttpError` + `SdkErrorCode.ClientHttpFailedToTerminateSession` |

```typescript
// v1
if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) { ... }
if (error instanceof StreamableHTTPError) { console.log('HTTP status:', error.code); }

// v2
import { SdkError, SdkHttpError, SdkErrorCode, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) { ... }
if (error instanceof SdkHttpError) {
    console.log('HTTP status:', error.status, error.statusText);
    switch (error.code) {
        case SdkErrorCode.ClientHttpAuthentication:
        case SdkErrorCode.ClientHttpForbidden:
        case SdkErrorCode.ClientHttpFailedToOpenStream:
        case SdkErrorCode.ClientHttpNotImplemented:
            break;
    }
}
```

`StreamableHTTPError` is removed.

**Status read off `.code` by duck-typing.** Code that classified HTTP failures by the
status without an `instanceof` — `if ('code' in e && e.code === 403)` — silently stops
matching: on `SdkHttpError` the HTTP status moved to `.status` (its `.code` is a
`SdkErrorCode` string). The codemod renames `instanceof StreamableHTTPError`, but a
status read that never named the class is invisible to it. Watch the inconsistency:
`SseError` still carries its HTTP status on numeric `.code`, so one duck-typed
`.code === 401` that caught both transports in v1 now catches only SSE.

```typescript
// v1 — one duck-typed check caught both Streamable HTTP and SSE
if ('code' in e && (e.code === 401 || e.code === 403)) reauth();
// v2 — match each explicitly
if (e instanceof SdkHttpError && (e.status === 401 || e.status === 403)) reauth(); // Streamable HTTP
if (e instanceof SseError && (e.code === 401 || e.code === 403)) reauth(); // SSE still uses .code
```

Silent at runtime (no compile error) — grep for `.code ===` status comparisons.

**Classification keyed on the error class name.** The same import-free classifiers
often match by name instead of code: telemetry and allowlists keyed on `error.name` or
`error.constructor.name` against `'McpError'` / `'StreamableHTTPError'` silently stop
matching — the v2 classes are named `ProtocolError`, `SdkError`, and `SdkHttpError`,
and all three assign `.name` accordingly. One v1 asymmetry disappears along the way:
v1's `StreamableHTTPError` never assigned `.name` (instances reported `'Error'`), so
`.name`-keyed matchers saw only `'McpError'`; v2's `SdkHttpError` reports
`'SdkHttpError'`, and assertions pinning `.name === 'Error'` on transport errors need
re-baselining. Add the v2 names to your match lists; during a
[staged migration](packaging-runtime.md#migrating-in-stages-large-codebases) keep the v1 names alongside
for as long as the v1 package remains installed.

**Status read out of the message text.** Per transport: the Streamable HTTP message
text never carried the status (v1 put it on `.code`, v2 puts it on `.status` — read
`error.status`), and v2's SSE transport still embeds it exactly as v1 did
(`Error POSTing to endpoint (HTTP 404): …`). The silent break is **switching
transports while keeping a message regex**: a status pattern written against SSE
matches nothing on Streamable HTTP. Read `error.status` instead of parsing text.

**Raw numeric code comparisons.** The codemod rewrites `ErrorCode.X` symbol references,
but a check against the raw JSON-RPC number — `(e as { code?: unknown }).code === -32000`
— is invisible to it and silently never matches in v2, because the two SDK-local codes
it usually targeted are now **string** `SdkErrorCode` values:

| v1 numeric                  | v2                                           |
| --------------------------- | -------------------------------------------- |
| `-32000` (ConnectionClosed) | `SdkError` + `SdkErrorCode.ConnectionClosed` |
| `-32001` (RequestTimeout)   | `SdkError` + `SdkErrorCode.RequestTimeout`   |

- Requests that require a session but omit the `Mcp-Session-Id` header still
  respond `400` with JSON-RPC `-32000` (`Bad Request: Mcp-Session-Id header is
required`), unchanged from v1 — as with `-32001`, the code is an SDK
  convention; key off the HTTP status.

Replace the literal with the named code. Loud (`TS2367`) when the compared value is
typed `SdkErrorCode`; silent when the left side is `unknown` or a cast — grep for
`=== -32000` / `=== -32001`.

**Dual-role processes: `instanceof` does not cross the packages.**
`@modelcontextprotocol/client` and `@modelcontextprotocol/server` each bundle their own
copy of these error classes, so in a process that uses both — a gateway, a host, an
in-process test — an error constructed by one package fails `instanceof` against the
class imported from the other, silently. When an error may originate from the other
package, match on stable fields instead of class identity: `error.code` values
(`SdkErrorCode` strings for SDK errors, numeric JSON-RPC codes for protocol errors,
`OAuthErrorCode` strings for OAuth errors) plus presence checks like `'status' in e`,
or reconstruct typed protocol errors with `ProtocolError.fromError(code, message, data)`
— it exists precisely because `instanceof` does not survive bundle boundaries.

**Constructing the error (test stubs, custom transports).** v1
`new StreamableHTTPError(code, message)` becomes
`new SdkHttpError(code, message, data)`: the first argument is now a `SdkErrorCode`
string (pick the branch from the scenario table above) and the HTTP status moves into
the third argument — `new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented,
'Not Found', { status: 404, statusText: 'Not Found' })`. v1's implicit
`Streamable HTTP error: ` message prefix is gone; pass the full message you want.

#### `SdkErrorCode` enum (complete)

| Code                                  | When thrown                                                                |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `NotConnected`                        | Transport is not connected                                                 |
| `AlreadyConnected`                    | Transport is already connected                                             |
| `NotInitialized`                      | Protocol is not initialized                                                |
| `CapabilityNotSupported`              | Required capability is not supported                                       |
| `RequestTimeout`                      | Request timed out waiting for response                                     |
| `ConnectionClosed`                    | Connection was closed                                                      |
| `SendFailed`                          | Failed to send message                                                     |
| `InvalidResult`                       | Response result failed local schema validation                             |
| `UnsupportedResultType`               | A 2026-era response carried an unrecognized `resultType`                   |
| `InputRequiredRoundsExceeded`         | Multi-round-trip auto-fulfilment hit `maxRounds`                           |
| `ListPaginationExceeded`              | No-arg `list*()` aggregate walk hit `listMaxPages`                         |
| `MethodNotSupportedByProtocolVersion` | Outbound spec method does not exist on the negotiated protocol version     |
| `EraNegotiationFailed`                | `connect()` could not negotiate a protocol era (probe failed / no overlap) |
| `ClientHttpNotImplemented`            | HTTP POST request failed                                                   |
| `ClientHttpAuthentication`            | Server returned 401 after re-authentication                                |
| `ClientHttpForbidden`                 | Server returned 403 `insufficient_scope` after step-up retry cap           |
| `ClientHttpUnexpectedContent`         | Unexpected content type in HTTP response                                   |
| `ClientHttpFailedToOpenStream`        | Failed to open SSE stream                                                  |
| `ClientHttpFailedToTerminateSession`  | Failed to terminate session                                                |

#### Typed `ProtocolError` subclasses

`ResourceNotFoundError` (carries `.uri`) and `MissingRequiredClientCapabilityError`
(carries `data.requiredCapabilities`) are new typed `ProtocolError` subclasses.
`resources/read` for an unknown URI now answers `-32602` on every protocol revision
(v1.x already emitted `-32602`; an interim `-32002` from earlier v2 alphas is mapped at
the encode seam — `2.0.0-alpha.3` and earlier predate the mapping and still emit
`-32002` on the wire, so accept both if peers may run those alphas; `2.0.0-alpha.4`
and later emit `-32602`). The encode-seam mapping applies to **your own throws too**: a handler
that deliberately throws `ProtocolError(ProtocolErrorCode.ResourceNotFound, …)` reaches
peers as `-32602` — a server can no longer emit `-32002` on the wire.
`ProtocolErrorCode.ResourceNotFound` (`-32002`) stays importable as
receive-tolerated vocabulary — accept both `-32602` and `-32002` from peers.
`ProtocolError.fromError(code, message, data)` reconstructs the typed subclass from
code + data alone — the version-agnostic path: it also works on plain wire shapes and
against SDK copies that predate brand-matched `instanceof`.
The default message text changed alongside: v1's unknown-resource error read
`Resource <uri> not found`; v2's `ResourceNotFoundError` default is
`Resource not found: <uri>` (the code is unchanged). Tests pinning the exact string
need re-baselining — prefer matching `error.code` plus a URI substring (or the typed
`error.uri`).

Custom **non-spec** codes pass through untouched: a handler that throws a
`ProtocolError` with a custom code (e.g. `-1`) and `data` reaches the peer as a
JSON-RPC error with that code and `data` unchanged — the encode seam rewrites only the
legacy `-32002` code; `data` is sent verbatim for every thrown error (the typed
subclasses shape their `data` at construction, not at encode time). Construct via
`ProtocolError.fromError(code, message, data)`.
