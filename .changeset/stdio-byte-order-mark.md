---
'@modelcontextprotocol/sdk': patch
---

Parse stdio messages that start with a UTF-8 byte order mark. When a peer wrote a BOM before a message (as some Windows tools and shell redirections do), `ReadBuffer` passed it to `JSON.parse`, the transport reported a `SyntaxError` on `onerror`, and the pending request waited
for its timeout. A leading U+FEFF is now stripped from each line before parsing, which RFC 8259 §8.1 allows.
