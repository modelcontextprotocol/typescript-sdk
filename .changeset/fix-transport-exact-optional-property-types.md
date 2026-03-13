---
'@modelcontextprotocol/core': patch
---

Fix TS2420 error when implementing Transport with exactOptionalPropertyTypes enabled

Optional callback properties on the Transport interface (`onclose`, `onerror`, `onmessage`, `setProtocolVersion`, `setSupportedProtocolVersions`) now explicitly include `| undefined` in their type signature. This makes the interface compatible with TypeScript's `exactOptionalPropertyTypes` compiler option, which was previously causing TS2420 "Class incorrectly implements interface" errors for users with that flag enabled.
