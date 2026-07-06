---
'@modelcontextprotocol/sdk': patch
---

Validate `Content-Type` by its parsed media type instead of a substring match. POSTs to the Streamable HTTP server transport whose media type is not `application/json` are now rejected with `415 Unsupported Media Type` (previously any value containing the substring passed, and valid case variants were wrongly rejected). Values with parameters (`application/json; charset=utf-8`, including malformed parameter sections like `application/json;`) continue to work, and the client's response dispatch uses the same parsed comparison.
