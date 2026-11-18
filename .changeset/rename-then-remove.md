---
'@modelcontextprotocol/server': patch
---

Fix `remove()` being a silent no-op after a resource, resource template, or prompt
has been renamed via `update()`. The closures for these three registration types
captured the original registry key and never reassigned it after a rename, so
`remove()` deleted the stale key instead of the one the entry now lives under —
leaving the entry listed and callable, with a `list_changed` notification firing
regardless. `RegisteredTool` already tracked its current key correctly; resources,
resource templates, and prompts now do the same.

Fixes #2723
