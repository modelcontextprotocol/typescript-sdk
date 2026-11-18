---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Carry the transport's last reported error into the `Connection closed` rejection. When a transport reports why it is closing — a `ReadBuffer` overflow, a stream error, a dropped socket — and then closes, every pending request was rejected with a bare `SdkError('Connection closed')` and the reason went only to `onerror`. Code doing the ordinary thing (`await client.listTools()`) was told the connection dropped and nothing else.

The rejection now reads `Connection closed: <reason>` with the transport's error as `cause`. Plain `Connection closed` remains the message when the transport reported nothing, when the caller closed the connection itself, and when a message was delivered after the error (the transport recovered, so the error is not why it closed). `SdkErrorCode.ConnectionClosed` is unchanged.
