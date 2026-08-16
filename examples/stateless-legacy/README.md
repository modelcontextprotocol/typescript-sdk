# stateless-legacy

The minimal `createMcpHandler` deployment, on its default posture: 2026-07-28 traffic served per request, 2025-era traffic served stateless from the same factory. This is the one-liner replacement for the 1.x "new transport + new server per POST" stateless idiom.

**HTTP-only** by definition; see `dual-era/` for the stdio analogue.
