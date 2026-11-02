---
"@modelcontextprotocol/client": patch
---

fix(stdio): stop EventEmitter listener accumulation in the stdio transport

Two sources of unbounded listener growth are fixed in `StdioClientTransport`:

- `send()` used to add a dedicated `drain` listener to `stdin` for every write
  that hit a full buffer, so sustained back-pressure accumulated listeners and
  triggered `MaxListenersExceededWarning`. Sends now share a single `drain`
  wait, and any still-pending sends are settled when the process is closed or
  disposed so their promises cannot hang.
- `close()` now detaches the listeners installed in `start()` (the `data`
  listener on `stdout` and the `error` listeners) and explicitly unpipes and
  ends the `stderr` pass-through. Ending the pass-through tears down any
  stream the caller piped it into (e.g. a shared log) deterministically, even
  when a grandchild keeps the child's `stderr` write-end open so the natural
  end cascade never fires.
