---
'@modelcontextprotocol/client': patch
---

`Client.connect()` now honors its `signal` during the `server/discover` probe in `auto` and pinned `versionNegotiation` modes. Aborting the signal rejects the connect promptly with the same error the legacy `initialize` path raises, instead of waiting out the probe timeout, and cancels the probe's HTTP request. A signal that is already aborted rejects before anything is sent. With the SDK's stdio transport the rejection waits for the probe sibling process to be reaped (up to about a second if it ignores `SIGTERM`), and the session process is never started.
