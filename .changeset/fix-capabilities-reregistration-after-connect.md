---
'@modelcontextprotocol/sdk': patch
---

Allow dynamic tool/resource/prompt registration after `connect()` when capabilities were pre-supplied at construction, by making `registerCapabilities` idempotent for already-present capability keys.
