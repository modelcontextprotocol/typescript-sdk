---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Add local inbound-processing completion metadata for transport adapters. Completion follows request handlers, response transmission and internal request cleanup; cancellation alone does not complete a request. The stdio entry preserves this metadata through opening and error paths and holds listen requests until subscription teardown. Export a stdio capability marker so reusable bounded admission can reject SDK versions without this contract.
