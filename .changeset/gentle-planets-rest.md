---
'@modelcontextprotocol/server': patch
---

Add `| undefined` to optional callback and function properties on `WebStandardStreamableHTTPServerTransportOptions` (`sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`) and corresponding private fields.

This fixes TS2430 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where optional properties with function types need explicit `| undefined` to match their emitted declarations.
