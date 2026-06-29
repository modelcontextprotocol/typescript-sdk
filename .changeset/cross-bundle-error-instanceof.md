---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`instanceof` on the SDK error classes (`ProtocolError` and its typed subclasses, `SdkError`/`SdkHttpError`, `OAuthError`, and the client's `SseError`) now works across separately bundled copies of the SDK. The classes match by a stable brand (via `Symbol.hasInstance` and a registry symbol) instead of prototype identity, so a process that uses both `@modelcontextprotocol/client` and `@modelcontextprotocol/server` - a gateway, host, or in-process test - can check errors constructed by either package against the class re-exported by the other. Ordinary prototype-based `instanceof` is preserved as a fallback; user-defined subclasses keep plain prototype semantics. Notes: cross-bundle matching requires both copies to be at or after this release; brands assert identity, not field shape, across versions - keep reading fields defensively. As a side effect, a foreign-bundle `SdkError` used as an abort reason is now rethrown as-is instead of being wrapped as a `RequestTimeout`.
