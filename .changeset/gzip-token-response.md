---
'@modelcontextprotocol/client': patch
---

Fix OAuth token exchange crashing with a JSON `SyntaxError` when the token
response body arrives as raw gzip bytes. Fetch implementations only
auto-decompress when the response carries a usable `Content-Encoding` header;
a proxy that strips the header (or a custom `fetchFn` that surfaces raw bytes)
handed the SDK compressed bytes that `response.json()` could not parse. Token
and OAuth error response bodies are now sniffed for the gzip magic bytes and
transparently decompressed via `DecompressionStream` before JSON parsing.
