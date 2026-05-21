---
'@modelcontextprotocol/core': patch
---

Fix `requestStream` to call `tasks/result` for failed tasks instead of yielding a hardcoded `ProtocolError`. When a task reaches the `failed` terminal status, the stream now retrieves and yields the actual stored result (matching the behavior for `completed` tasks), as required by the spec.
