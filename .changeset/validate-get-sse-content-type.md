---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` now validates the `Content-Type` of a GET/resume SSE response. The standalone-GET and resume paths piped the response body straight into the SSE parser without checking `Content-Type`, so a proxy, captive portal, or misconfigured server answering the GET with `200` and a non-SSE body (e.g. `text/html`) was silently swallowed — the parser produced no events, `onerror` never fired, and the caller believed it was attached to a live stream. The GET path now applies the same `mediaTypeEssence` check the POST path already uses and throws `SdkError(ClientHttpUnexpectedContent)` when the media type is not `text/event-stream`, matching the Streamable HTTP spec requirement that a GET returns `text/event-stream` or `405`.
