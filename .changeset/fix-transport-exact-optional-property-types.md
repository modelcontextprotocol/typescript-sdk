---
'@modelcontextprotocol/core': patch
---

Add explicit `| undefined` to optional properties on the `Transport` interface and `TransportSendOptions` (`onclose`, `onerror`, `onmessage`, `sessionId`, `setProtocolVersion`, `setSupportedProtocolVersions`, `onresumptiontoken`).

This fixes TS2420 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where the emitted `.d.ts` for implementing classes included `| undefined` but the interface did not.

Workaround for older SDK versions: enable `skipLibCheck: true` in your tsconfig.
