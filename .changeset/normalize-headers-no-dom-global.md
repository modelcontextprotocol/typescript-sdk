---
'@modelcontextprotocol/sdk': patch
---

Stop `normalizeHeaders` from referencing the DOM-only global `HeadersInit`, so Node-only projects without the `DOM` lib compile with `skipLibCheck: false`
