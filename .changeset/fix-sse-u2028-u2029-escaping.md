---
'@modelcontextprotocol/sdk': patch
---

Escape `U+2028` (LINE SEPARATOR) and `U+2029` (PARAGRAPH SEPARATOR) in `WebStandardStreamableHTTPServerTransport` and `SSEServerTransport` SSE `data:` lines. `JSON.stringify` leaves these codepoints unescaped, but many SSE client parsers treat them as line terminators and
truncate the frame mid-JSON, which made tool calls silently hang on the client whenever a response contained either character.
