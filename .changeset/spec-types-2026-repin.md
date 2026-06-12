---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Internal: regenerate the 2026-07-28 spec reference types from the latest draft schema (`DiscoverResult` now extends `CacheableResult`; `ElicitationCompleteNotificationParams` extracted as a named interface) and document the anchor lifecycle policy. Released-revision spec-type generation is now pinned to a fixed spec commit; draft anchors keep floating via the nightly refresh PRs. No public API or runtime behavior changes.
