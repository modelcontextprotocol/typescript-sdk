## Enhancements

### Automatic JSON Schema validator selection by runtime

The SDK auto-selects the validator: Node.js → AJV; Cloudflare Workers (workerd) →
`@cfworker/json-schema`. Cloudflare Workers users can remove explicit
`jsonSchemaValidator` configuration. You don't need to install `ajv`, `ajv-formats`, or
`@cfworker/json-schema` for the default path. To customize the built-in backend, import
the named class from the explicit subpath
(`@modelcontextprotocol/{client,server}/validators/ajv` or `…/cf-worker`) — importing
from a subpath means the corresponding peer dep must be in your `package.json`.

### `Client.connect(transport, { prior })` — connect from a cached era verdict

Probe once, persist `client.getDiscoverResult()` (`JSON.stringify`), and feed it to
every worker as `client.connect(transport, { prior: { kind: 'modern', discover } })`.
New exported types
`ConnectOptions` (extends `RequestOptions` with `prior?: PriorDiscovery`)
and `PriorDiscovery` — a cached era verdict: the modern arm wraps a `DiscoverResult`
(zero round trips), the legacy arm (`{ kind: 'legacy' }`) skips the probe and runs the
plain `initialize` handshake for servers known to be pre-2026. Freshness is the
supplying host's responsibility — date cached legacy verdicts in your own storage and
stop supplying them past your policy horizon (a stale one succeeds silently against an
upgraded server).

### Serving the 2026-07-28 revision

`createMcpHandler`, `serveStdio`, `versionNegotiation`, multi-round-trip requests
(`requestState`), client cancellation via stream-close, `subscriptions/listen`,
`Mcp-Param-*` headers, and per-era wire codecs are covered in
**[support-2026-07-28.md](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md)** — they are net-new in v2, not v1→v2
breaks.
