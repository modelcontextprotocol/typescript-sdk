---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/hono': patch
'@modelcontextprotocol/node': patch
---

POSTs whose `Content-Type` media type is not `application/json` are now
rejected with `415 Unsupported Media Type`; the header is parsed instead of
substring-matched. Previously any value merely containing the substring
passed the check (for example `text/plain; a=application/json`), case
variants were wrongly rejected, and the 2026-07-28 entry did not inspect
`Content-Type` at all — requests with a missing or non-JSON header that used
to be served on that path now also answer 415. Values with parameters
(`application/json; charset=utf-8`, including malformed parameter sections
like `application/json;`) continue to work. SDK clients always send the
correct header and are unaffected.

The new `isJsonContentType(header)` helper is exported for transport and
framework-adapter authors — custom entries composing the exported building
blocks (`classifyInboundRequest`, `PerRequestHTTPServerTransport`) must apply
it themselves. The hono adapter's JSON body pre-parse and the client's
response dispatch now use the same parsed-media-type comparison.
