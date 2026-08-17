---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Reject a modern (2026-07-28) POST that omits the required `MCP-Protocol-Version` header.

`createMcpHandler` accepted a request whose body carried a valid per-request `_meta`
envelope but whose `MCP-Protocol-Version` header was absent: the request was classified
modern, dispatched, and answered `200` — tool handlers ran. Only the _mismatch_ case
(header present, disagreeing with the body) was rejected, so of the standard headers
SEP-2243 requires on a modern POST, presence was enforced for `Mcp-Method` (and for
`Mcp-Name` on the methods that mirror `params.name` / `params.uri`) but not for
`MCP-Protocol-Version`.

Such a request is now refused with `400 Bad Request` and JSON-RPC `-32020`
(`HeaderMismatch`), matching the shape the sibling missing-header cells already emit and
echoing the request id — per the Streamable HTTP spec, which requires the header on every
POST and lists a missing required standard header as a `HeaderMismatch` failure. The
spec's allowance to treat a header-less request as `2025-03-26` is available only to a
server that also serves pre-2025-06-18 clients, and permits routing it to _legacy_
handling — never serving it as 2026-07-28; under `legacy: 'reject'` the requirement is
unconditional.

Era classification is deliberately unchanged and stays body-primary: a proxy that strips
the header still must not change the era, so such a request is still _classified_ modern
and is refused one rung later, at `standard-header-validation` — the same rung that
already answers a missing `Mcp-Method`. Legacy-era traffic is untouched, notifications
are unaffected, body-less `GET` / `DELETE` session operations are method-routed before
any header validation, and stdio serving (which has no HTTP headers) is not involved.

Clients built with this SDK always send the header, so no first-party client is affected;
hand-rolled clients that omitted it must add it.
