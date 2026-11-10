---
'@modelcontextprotocol/client': patch
---

`StdioClientTransport` with `stderr: 'pipe'` (or `'overlapped'`) no longer deadlocks the session when nothing reads `transport.stderr`. The piped
`PassThrough` is now resumed after `start()`, so a child that writes more than the stream's 16 KiB buffer and the OS pipe can hold keeps
draining instead of blocking on `write(2)` and starving its own stdin. Listeners attached before `start()` / `Client.connect` still receive
every chunk; a listener attached afterwards sees only data written after it attached, and paused-mode `read()` is no longer supported once
the stream is flowing.
