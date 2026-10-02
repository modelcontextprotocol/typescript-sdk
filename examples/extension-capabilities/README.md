# extension-capabilities

The server declares one extension capability, `com.example/feature-flags`, with
a small settings object via `server.registerCapabilities({ extensions: { … } })`.
The client connects once per era leg and asserts the entry and its settings are
advertised — by the `initialize` result on the legacy leg and by
`server/discover` on the modern leg.

```bash
pnpm tsx examples/extension-capabilities/client.ts          # modern (server/discover)
pnpm tsx examples/extension-capabilities/client.ts --legacy # 2025 initialize handshake
```
