---
'@modelcontextprotocol/codemod': minor
---

Add an `error-code-semantics` transform that fixes `instanceof` guards around the
`ErrorCode.RequestTimeout` / `ErrorCode.ConnectionClosed` members, which moved from the
protocol error enum to `SdkErrorCode` (raised on `SdkError`) in v2. Without this, migrated
checks like `e instanceof ProtocolError && e.code === SdkErrorCode.RequestTimeout` compile
but never match at runtime. The transform also flags switches and maps that mix the two
enums, since `SdkErrorCode` is a string enum.
