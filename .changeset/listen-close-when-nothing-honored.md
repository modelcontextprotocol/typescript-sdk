---
'@modelcontextprotocol/server': patch
---

`createMcpHandler` now ends a `subscriptions/listen` stream right after the acknowledgement when it honored none of the requested notification types, instead of holding the stream open with nothing to deliver. The client receives the acknowledgement and then the `resultType: "complete"` result. Streams that honor at least one type are unchanged.
