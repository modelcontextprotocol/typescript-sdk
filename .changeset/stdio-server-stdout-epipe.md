---
'@modelcontextprotocol/sdk': patch
---

Handle `stdout` errors in `StdioServerTransport` instead of crashing the process. When a stdio client disconnects, the server's next write fails with `EPIPE`, and because nothing listened for `'error'` on `stdout` that became an unhandled `'error'` event, which takes the whole
Node process down. The transport now listens for it, reports it through `onerror`, and closes itself, so a client that goes away ends the session rather than killing the server.

`send()` no longer waits for a `'drain'` event that a destroyed stream can never emit. It settles from an error listener armed before the write and removes both listeners on every exit path, so a write that fails rejects with the underlying error instead of leaving the promise
pending, and `send()` after `close()` rejects rather than writing to a stream the transport has let go of. `close()` is idempotent too, so an error-triggered close followed by an explicit one fires `onclose` once.

This backports the fix that shipped for the v2 line, so both lines now behave the same way on a disconnecting client.
