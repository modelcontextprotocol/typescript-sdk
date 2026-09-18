---
'@modelcontextprotocol/server': patch
---

Install `createMcpHandler`'s in-flight `onclose` hook at most once per server instance. The factory contract is one fresh instance per request, but a factory that returns the same instance every time (`createMcpHandler(() => sharedServer)`) previously stacked one `onclose` wrapper per request. The chain retained every closure for the life of the process and, once it ran, recursed one frame per accumulated layer — dying with `RangeError: Maximum call stack size exceeded` after roughly 20k requests, as an uncaught async error that surfaced _after_ `handler.close()` had already resolved. Instance reuse still is not the intended pattern, but it now costs O(1) instead of crashing the process.
