---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

author: @KKonstantinov
author: @tobi-oye
author: @mattzcarey

Add the Skills extension (SEP-2640), reachable through new `ext/skills` subpaths; package root exports are unchanged.

- `@modelcontextprotocol/server/ext/skills`: `SkillsExtension` (`attach(server)` serves `skills/list`, `skills/get`, `resources/directory/read` and a `skill://{+path}` resource template), `SkillsExtension.load(files)` returning a `SkillCatalog` with `entries` and `reload()`, the `SkillFiles` storage adapter with `memorySkillFiles`, `SkillSource` for generated catalogs, `skillEntry`, and `SkillCatalogError`. Invalid skills are skipped with a warning (`onWarning`), or fail under `strict`. A file whose bytes are valid UTF-8 is served as `text`, whatever its MIME type; any other file as a base64 `blob`.
- `@modelcontextprotocol/server/ext/skills/node`: `loadSkills(folder)` and `nodeSkillFiles(folder)`.
- `@modelcontextprotocol/client/ext/skills`: `SkillsClient` with `list()` (throws on an invalid entry; `skipInvalid: true` keeps the valid ones and returns the rest in `invalid`), `get()`, `read(skill, path?)` (size, digest and `SKILL.md` frontmatter verified, `SkillVerificationError` on a mismatch; a copy from the response cache that fails a check is fetched once more with `cacheMode: 'refresh'` first) and `readDirectory()`.
- `@modelcontextprotocol/core/ext/skills`: schemas, types and constants, including `SKILL_LIMITS`. The result schemas follow the stable spec, so `ttlMs` and `cacheScope` are required.

Works on 2025-11-25 and 2026-07-28. On 2026-07-28 only, the server sends the caching fields (`ttlMs`, `cacheScope`), and `SkillsClient` requires them and returns them from `list()`, `get()` and `readDirectory()`.
