---
'@modelcontextprotocol/server': patch
---

Honor `disable()` on resource templates. `resources/list`, `resources/templates/list`, `resources/read` and `completion/complete` never read the `enabled` flag, so a disabled template stayed listed, readable, and completable.
