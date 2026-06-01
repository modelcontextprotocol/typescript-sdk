---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Adds the `DRAFT_PROTOCOL_VERSION_2026` / `DRAFT_PROTOCOL_VERSIONS` constants and the `allowDraftVersions` option. Draft protocol versions can now be listed in `supportedProtocolVersions` when explicitly allowed; they are never negotiable by default and never appear in the default supported set.

`supportedProtocolVersions` entries are now validated at construction: every entry must be a released protocol version (`SUPPORTED_PROTOCOL_VERSIONS`) or a known draft version (`DRAFT_PROTOCOL_VERSIONS`), and listing a draft version without `allowDraftVersions: true` throws.
