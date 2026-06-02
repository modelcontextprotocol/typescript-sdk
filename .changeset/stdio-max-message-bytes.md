---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `maxMessageBytes` option to the stdio transports and make the stdio read buffer amortized O(1) per byte

A stdio peer that writes a very large amount of data without a newline (accidental binary output, runaway log line, or a malicious server) previously grew the receiving process's memory without bound, and each incoming chunk re-copied the entire buffered backlog (`Buffer.concat` per chunk). There was no public way to bound or replace the read buffer, so integrators who had built flood protection on v1 transport internals had nothing to migrate to.

`StdioClientTransport` and `StdioServerTransport` now accept an optional `maxMessageBytes`. When a single message exceeds it, the data is dropped, an `SdkError` with the new code `SdkErrorCode.MessageTooLarge` is reported via `onerror`, and the transport recovers at the next newline boundary. The default remains unlimited. The read buffer also now grows geometrically with read/scan offsets instead of concatenating on every chunk.
