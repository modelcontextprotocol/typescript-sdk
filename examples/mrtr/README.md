# mrtr (multi-round-trip requests)

A write-once `deploy` tool that requests client input by **returning** `inputRequired(...)` instead of pushing a server→client request (protocol revision 2026-07-28). State between rounds is carried in `requestState`, which the example HMAC-protects and verifies via the
`ServerOptions.requestState.verify` hook (a wire-level `-32602` on tamper).

The client drives both the default auto-fulfilment mode (your existing `elicitation/create` handler is dispatched for you and `callTool()` returns a plain `CallToolResult`) and manual mode (`autoFulfill: false` + `allowInputRequired: true`).

```bash
pnpm tsx examples/mrtr/client.ts
```
