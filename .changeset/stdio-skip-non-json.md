---
'@modelcontextprotocol/core': patch
---

`ReadBuffer.readMessage()` now silently skips non-JSON lines instead of throwing `SyntaxError`. This prevents noisy `onerror` callbacks when hot-reload tools (tsx, nodemon) write debug output like "Gracefully restarting..." to stdout. Lines that parse as JSON but fail JSONRPC schema validation still throw.
