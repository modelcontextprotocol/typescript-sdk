---
'@modelcontextprotocol/core-internal': patch
---

Eliminate quadratic copying and rescanning in `ReadBuffer` when receiving messages across multiple chunks. Incoming chunks are retained without intermediate concatenation, and message delimiter scanning inspects newly appended bytes rather than repeatedly rescanning earlier buffered content.
