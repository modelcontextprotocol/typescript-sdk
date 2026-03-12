---
'@modelcontextprotocol/core': patch
---

Fix InMemoryTaskStore to enforce session isolation. Previously, sessionId was accepted but ignored on all TaskStore methods, allowing any session to enumerate, read, and mutate tasks created by other sessions. The store now persists sessionId at creation time and enforces ownership on all reads and writes.
