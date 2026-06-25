---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Add a configurable `maxBufferSize` (default 10 MB) to the stdio transports. When a single message would push the read buffer past the limit, the transport now emits an `onerror` and closes instead of growing the buffer unbounded. Configure via `new StdioClientTransport({ ..., maxBufferSize })` or `new StdioServerTransport(stdin, stdout, { maxBufferSize })`. The default is exported from `@modelcontextprotocol/core-internal` as `STDIO_DEFAULT_MAX_BUFFER_SIZE`.
