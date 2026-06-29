---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

Complete the SEP-2577 `@deprecated` sweep on the public type surface (SEP-2596 Tier-1 obligation). Marks the full Logging type stack (`LoggingLevel`, `SetLevelRequest`, `LoggingMessageNotification` and params), the full Sampling type stack (`CreateMessageRequest`/`Result`, `SamplingMessage`, `ModelPreferences`/`ModelHint`, `ToolChoice`, `ToolUseContent`/`ToolResultContent`, and the `includeContext` enum values), the full Roots type stack (`Root`, `ListRootsRequest`/`Result`, `RootsListChangedNotification`), and `registerClient` (Dynamic Client Registration; prefer Client ID Metadata Documents per SEP-991). Mirrors the markers already present on the per-revision reference types. JSDoc only — wire behavior is unchanged; everything remains fully functional during the deprecation window (at least twelve months).
