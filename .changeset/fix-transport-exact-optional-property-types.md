---
'@modelcontextprotocol/sdk': patch
---

Add explicit `| undefined` to the optional properties of the `Transport` interface (`onclose`, `onerror`, `onmessage`, `sessionId`).

Under `exactOptionalPropertyTypes: true`, `onclose?: () => void` means the property may be absent but never explicitly `undefined`. The concrete transports declare these members as accessors typed `(() => void) | undefined`, so the SDK's own transports were not assignable to the
SDK's own `Transport` interface, and `server.connect(new StreamableHTTPServerTransport(...))` failed with TS2379. Consumers had to either cast at the call site or disable the flag for their whole project.

This is a backport of the same fix already merged on `main` in #1766, and resolves #2083 for the v1 line.
