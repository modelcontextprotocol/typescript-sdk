### HTTP & headers

Header **reads** use the Web Standard `Headers` object (`IsomorphicHeaders` is
removed): `ctx.http?.req` is a standard Web `Request`, so
`ctx.http?.req?.headers` takes `.get()` instead of bracket access.

```typescript
// v1
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer token' } }
});
const sessionId = extra.requestInfo?.headers['mcp-session-id'];

// v2 — requestInit is unchanged; only the header *read* changes
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer token' } }
});
const sessionId = ctx.http?.req?.headers.get('mcp-session-id');
const debug = new URL(ctx.http!.req!.url).searchParams.get('debug');
```

On the **write** side, `requestInit` on `StreamableHTTPClientTransport` /
`SSEClientTransport` options is a standard fetch `RequestInit`, so `headers` accepts
any `HeadersInit` — a plain object record (as above), a tuple array, or a `Headers`
instance all keep working unchanged; the transports normalize whichever form they
receive. Wrapping with `new Headers()` is optional, not required.

`StreamableHTTPClientTransport` now **appends** any custom `requestInit.headers.Accept`
value to the spec-required `application/json, text/event-stream` (v1 let it replace
them). The required media types are always present; additional types are kept for
proxy/gateway routing.

Transport-managed headers now take precedence over same-named entries in
`requestInit.headers`: `Authorization` when `authProvider` yields a token,
`mcp-protocol-version`, and (Streamable HTTP) `mcp-session-id`. v1 let the configured
header win, so a static `Authorization` placeholder kept overriding the OAuth token even
after the provider obtained one. A configured `Authorization` value is still sent while
the provider has no token, which is what lets a static API key fall back to OAuth.

`hostHeaderValidation()` and `localhostHostValidation()` moved to
`@modelcontextprotocol/express`. The `(allowedHostnames: string[])` signature is the
same as every released v1.x — only the import path changes. Framework-agnostic helpers
(`validateHostHeader`, `localhostAllowedHostnames`, `hostHeaderValidationResponse`) are
in `@modelcontextprotocol/server`.

Server entries validate the request `Content-Type` by its **parsed media type**, not a
substring: every POST whose media type is not `application/json` answers
`415 Unsupported Media Type`. Previously any value merely containing the substring
passed (for example `text/plain; a=application/json`), case variants were wrongly
rejected, and the 2026-07-28 entry did not inspect `Content-Type` at all — so
hand-rolled clients that omit the header (or send a non-JSON type) must now set
`Content-Type: application/json`. Parameters (`; charset=utf-8`) and unambiguous
values with malformed parameter sections (`application/json;`) keep working; SDK
clients always sent the correct header and are unaffected. Custom entries that
compose `classifyInboundRequest` / `PerRequestHTTPServerTransport` directly must
apply the same validation themselves — use the exported `isJsonContentType(header)`.
