---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Resynchronise `ReadBuffer` at the next message boundary after an oversized message. On overflow the buffer was cleared and reading continued, but the rest of the oversized message was still arriving: it landed in the empty buffer and was fed to the parser as if it were the start of a new message, and a large enough remainder accumulated until it overflowed a second time. The remainder is now dropped, unbuffered, up to and including the newline that ends it, and parsing resumes with whatever follows. One oversized message now produces one error.
