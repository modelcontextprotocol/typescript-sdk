---
'@modelcontextprotocol/client': patch
---

Receiving a large message as a single SSE event, such as a tool result of tens of megabytes, is now fast: a 50 MB result that took about 13 seconds arrives in under a second. The client now requires `eventsource-parser` 3.0.8 or later, which reads such an event in linear time.
