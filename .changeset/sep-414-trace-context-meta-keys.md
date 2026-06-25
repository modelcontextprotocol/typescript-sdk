---
'@modelcontextprotocol/core': patch
---

Add reserved trace context `_meta` key constants (`TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, `BAGGAGE_META_KEY`) per SEP-414, plus docs and a passthrough regression test. The spec reserves the unprefixed `_meta` keys `traceparent`, `tracestate`, and `baggage` (W3C Trace Context / W3C Baggage formats) for distributed tracing; the SDK passes them through untouched.
