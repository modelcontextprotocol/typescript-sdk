---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/node': patch
'@modelcontextprotocol/hono': patch
'@modelcontextprotocol/express': patch
---

Read Streamable HTTP request bodies with a size limit. Every SDK-owned body read —
`WebStandardStreamableHTTPServerTransport` (and the Node transport built on it),
`createMcpHandler`, `toNodeHandler`, and `createMcpHonoApp`'s JSON pre-parse — now stops at
4 MiB by default (the limit the legacy SSE transport already uses; the Express adapter and stdio
bound their reads too) and answers `413 Payload Too Large` before anything is parsed.
`toWebRequest` (when it reads the Node stream itself) now rejects once the body exceeds the
limit with an error whose `name` is `'RequestBodyTooLargeError'` and `status` is `413`, and
`toNodeHandler` answers that with `413`; hand-wired callers of `toWebRequest` should handle the
rejection or pass a pre-parsed body, and `isLegacyRequest` reports such a request as non-legacy
so the modern handler answers it. JSON-RPC batch arrays are limited to 100 messages; a longer
batch is answered `400` / `-32600` and none of it is dispatched.

The limit is configurable with a new `maxRequestBodySize` option (bytes, default
`DEFAULT_MAX_REQUEST_BODY_SIZE` = 4 MiB, exported from `@modelcontextprotocol/server`) on
`WebStandardStreamableHTTPServerTransportOptions`, `CreateMcpHandlerOptions` (forwarded to its
stateless legacy leg; `isLegacyRequest` and `legacyStatelessFallback` take the same option),
`CreateMcpHonoAppOptions`, and `ToNodeHandlerOptions` / `ToWebRequestOptions` (the adapter's
bound applies before the handler's, so raise both). The bounded reader is exported as
`readRequestBody` for adapter authors. Hosts that pre-parse the body and pass it as
`parsedBody` skip the SDK's read and its size limit entirely; the batch bound applies either way.

`createMcpHonoApp` and `createMcpExpressApp` now run their Host/Origin validation before the
JSON body parser, so a request from a disallowed Host or Origin with an invalid JSON body is
answered `403` rather than `400`, and its body is not read.
