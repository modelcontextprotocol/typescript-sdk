# sampling

A tool that requests LLM sampling from the client via `ctx.mcpReq.requestSampling(...)`. The client advertises `sampling` and registers a `sampling/createMessage` handler returning a canned response.

> Sampling is **deprecated** as of protocol revision 2026-07-28 (SEP-2577) but remains functional during the deprecation window.

**stdio-only** in the harness: push server→client requests need either a stdio connection or a sessionful HTTP transport (see `../legacy-routing/`); the harness's `--http` arm is the per-request `createMcpHandler`, which serves the 2026-07-28 path where sampling is unavailable.

```bash
pnpm tsx examples/sampling/client.ts --legacy
```
