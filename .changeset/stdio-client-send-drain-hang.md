---
'@modelcontextprotocol/client': patch
---

Fix `StdioClientTransport.send()` never settling when a backpressured write is still in flight and the pipe to the server dies. `send()` waited for a `'drain'` event, but a destroyed stream never drains, so the returned promise stayed pending and the `'drain'` listener was never removed. It now settles from the `write()` callback, which Node invokes on flush or on failure, so the send rejects with the underlying write error instead. This is what `StdioServerTransport.send()` already does for its own stdout.

The visible symptom was `await client.notification(...)`, which never returned: the notification path awaits the transport send with no timeout, and the connection-closed teardown settles pending responses but not pending sends. Requests were already rescued by that teardown, so `callTool()` and friends now report the actual write error (`EPIPE`, `EOF`) rather than a generic connection-closed error.

Reaching this needs a write the pipe will not accept in one go, which starts anywhere from tens to hundreds of KB depending on the platform pipe buffer and the Node version, sizes that base64 image payloads and file contents in tool arguments reach routinely.
