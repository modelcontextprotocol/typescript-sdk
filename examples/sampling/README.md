# sampling

A tool that requests LLM sampling from the client via `ctx.mcpReq.requestSampling(...)`. The client advertises `sampling` and registers a `sampling/createMessage` handler returning a canned response.

> Sampling is **deprecated** as of protocol revision 2026-07-28 (SEP-2577) but remains functional during the deprecation window.

Runs both transports on the **legacy** era — sampling is a 2025-era push-style server→client request and there is no 2026-07-28 equivalent. The harness's `--http` arm hosts 2025 traffic on a sessionful transport, so the request reaches the client over either.

```bash
pnpm --filter @mcp-examples/sampling client -- --legacy
```
