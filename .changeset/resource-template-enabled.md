---
'@modelcontextprotocol/server': patch
---

Honour `enabled` on resource templates. `registerResource` returns a handle with `enable()`, `disable()` and `enabled` for every primitive, but the resource-template registry was the only one nothing ever read: the flag was stored and the `list_changed` notification fired, while the template stayed listed and readable.

A disabled template was still returned by `resources/list` and `resources/templates/list`, still served by `resources/read`, and still answered `completion/complete`. Static resources registered through the same call were already guarded, so the two behaved differently in the same handler — `disable()` on a static resource errored the read, `disable()` on a template did not.

Callers using `disable()` to withdraw access to a family of resources were therefore still serving them. Tools, prompts and static resources are unchanged.
