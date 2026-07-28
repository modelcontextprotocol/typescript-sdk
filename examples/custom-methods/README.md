# custom-methods

Bidirectional custom (non-spec) JSON-RPC methods: the server handles a vendor-prefixed `acme/search` request via `server.setRequestHandler` and emits `acme/searchProgress` notifications via `ctx.mcpReq.notify`; the client sends the typed request via
`client.request(method, schema)` and receives the typed notifications via `client.setNotificationHandler('acme/searchProgress', { params })`.

```bash
pnpm tsx examples/custom-methods/client.ts
```
