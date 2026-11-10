---
'@modelcontextprotocol/codemod': patch
---

Account for patch versions in Zod comparator upper bounds so the migrator does not warn about ranges such as `>=4.2.0 <4.2.1` that satisfy the SDK's minimum version.
