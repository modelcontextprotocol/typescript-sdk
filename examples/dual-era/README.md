# dual-era

One server factory, both protocol eras (2025 `initialize` and 2026-07-28 per-request envelope), both transports (stdio and Streamable HTTP). The client connects once as a plain 2025 client and once with `versionNegotiation: { mode: 'auto' }`; the same `greet` tool answers both
and reports which era served the call.

This is the recommended **first** example to read if you are migrating an existing server to the 2026 era: the entry (`serveStdio` / `createMcpHandler`) owns the era decision, the factory is era-agnostic.

```bash
pnpm tsx examples/dual-era/client.ts                              # stdio
pnpm tsx examples/dual-era/server.ts --http --port 3000           # term 1
pnpm tsx examples/dual-era/client.ts --http http://127.0.0.1:3000/ # term 2
```
