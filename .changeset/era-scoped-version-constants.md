---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/codemod': patch
---

Rename `LATEST_PROTOCOL_VERSION` → `LATEST_LEGACY_PROTOCOL_VERSION` and
`SUPPORTED_PROTOCOL_VERSIONS` → `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` (values
unchanged) so the constants name their era, and make `isModernProtocolVersion`
and `FIRST_MODERN_PROTOCOL_VERSION` public. The old names remain as
`@deprecated` aliases until 2.0.0 GA; the v1→v2 codemod applies the rename.
See the [Protocol versions guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions#the-constants-are-era-scoped).
