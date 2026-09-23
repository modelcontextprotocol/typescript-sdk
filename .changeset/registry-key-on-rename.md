---
'@modelcontextprotocol/server': patch
---

Keep the registry key current when a prompt, resource or resource template handle is renamed. The `update` closure captured the registration key and never reassigned it, so after one rename it was pointing at a key the entry no longer occupied.

- `remove()` became a silent no-op. It deletes the captured key, which is already vacant, and the entry stays in `prompts/list` / `resources/list` / `resources/templates/list` and stays callable. `list_changed` still fires, so clients are told the list changed when it did not.
- A second rename left the intermediate key registered, aliasing one entry under two names — both listed, both live.
- Renaming back to the original name silently did nothing, because the `updates.name !== name` guard compared against the stale captured value and skipped the whole block.

`RegisteredTool` already tracked the current key and is unaffected.
