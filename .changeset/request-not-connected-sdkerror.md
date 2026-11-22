---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

A request sent while not connected (before `connect()` or after `close()`) now rejects with `SdkError` and code `SdkErrorCode.NotConnected`, as the v2 upgrade guide documents and as notifications and the client transports already do. It rejected with a plain `Error('Not connected')`, so `error instanceof SdkError && error.code === SdkErrorCode.NotConnected` checks never matched for `callTool`, `ping`, `readResource` and the other request methods. The message is unchanged and `SdkError` extends `Error`, so checks on the message or on `Error` still match.
