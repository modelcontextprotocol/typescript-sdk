---
'@modelcontextprotocol/client': patch
---

Drop inbound JSON-RPC requests on connections that negotiated the 2026-07-28 draft revision instead of answering them: the modern era has no server→client request channel (server-initiated interactions are carried in `input_required` results), and the stdio transport forbids the
client from writing JSON-RPC responses. Dropped requests are surfaced via `onerror`. Legacy-era connections, responses, and notifications are unchanged.
