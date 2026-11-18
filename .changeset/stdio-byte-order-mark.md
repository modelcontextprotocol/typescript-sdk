---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Parse stdio messages that start with a UTF-8 byte order mark. `ReadBuffer` skips lines that fail to parse as JSON, so when a peer wrote a BOM before a message (as some Windows tools and shell redirections do), that message was dropped without an error and the pending request waited for its timeout. A leading U+FEFF is now stripped from each line before parsing, which RFC 8259 §8.1 allows.
