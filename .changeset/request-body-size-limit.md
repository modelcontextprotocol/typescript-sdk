---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/node': patch
'@modelcontextprotocol/hono': patch
---

Read Streamable HTTP request bodies with a size limit. Every SDK-owned body read —
`WebStandardStreamableHTTPServerTransport` (and the Node transport built on it),
`createMcpHandler`, `toNodeHandler`, and `createMcpHonoApp`'s JSON pre-parse — now stops at
4 MiB (the limit the legacy SSE transport already uses; the Express adapter and stdio bound
their reads too) and answers `413 Payload Too Large` before anything is parsed.
`toWebRequest` (when it reads the Node stream itself) now rejects once the body exceeds the
limit, and `toNodeHandler` answers that with `413`; hand-wired callers of `toWebRequest`
should handle the rejection or pass a pre-parsed body, and `isLegacyRequest` reports such a
request as non-legacy so the modern handler answers it. JSON-RPC batch arrays
are limited to 100 messages; a longer batch is answered `400` / `-32600` and none of it is
dispatched. `createMcpHonoApp` also runs its Host/Origin validation before the JSON
pre-parse, so a request from a disallowed Host with an invalid JSON body is now answered
`403` rather than `400`.

Hosts that need to accept larger JSON-RPC bodies can parse the body themselves and pass it
as `parsedBody`, in which case the SDK reads nothing and applies no size limit; the batch
bound applies either way.
