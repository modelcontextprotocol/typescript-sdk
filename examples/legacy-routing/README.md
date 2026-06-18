# legacy-routing

`isLegacyRequest` routing: keep an **existing** sessionful 1.x Streamable HTTP deployment serving 2025-era clients, add a strict `createMcpHandler({ legacy: 'reject' })` for 2026-07-28 traffic, on the **same port**. The predicate decides per request which arm handles it.

**HTTP-only** by definition; see also `dual-era/` for the simple case where you don't have a sessionful deployment to keep.
