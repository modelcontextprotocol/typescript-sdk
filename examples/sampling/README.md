# sampling

A tool that asks the host LLM for a completion. One factory, both protocol eras: sampling works on both eras with different APIs — push-style on 2025, `inputRequired` on 2026; the protocol carries the `sampling/createMessage` request differently but the user experience is the
same.

| 2025-era (`--legacy`, push-style)                                                                                                                | 2026-07-28 (multi-round-trip)                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await ctx.mcpReq.requestSampling({ messages, maxTokens })` — the server pushes a `sampling/createMessage` request and awaits the answer in-line | `return inputRequired({ inputRequests: { summary: inputRequired.createMessage({ messages, maxTokens }) } })` — the client fulfils the embedded request and retries with the response attached |

The client registers **one** `sampling/createMessage` handler; on the 2026-07-28 leg the auto-fulfilment driver dispatches the embedded request to that same handler.

> Push-style sampling is **deprecated** as of protocol revision 2026-07-28 (SEP-2577) but remains functional during the deprecation window.

Push-style sampling is exercised on **stdio/legacy** (`createMcpHandler`'s stateless-legacy posture has no return path for the client's response POST — see `../legacy-routing/` for the sessionful composition); the http/legacy leg only verifies the initialize handshake.
2026-07-28 `inputRequired.createMessage` runs on both transports.

```bash
pnpm --filter @mcp-examples/sampling client               # 2026-07-28 (inputRequired)
pnpm --filter @mcp-examples/sampling client -- --legacy   # 2025 (push-style)
```
