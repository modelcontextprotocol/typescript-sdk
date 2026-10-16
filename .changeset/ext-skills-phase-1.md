---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/core': minor
---

Add first-class Skills extension (SEP-2640) APIs behind new `/ext/skills` subpath exports. Root barrels are unchanged.

- `@modelcontextprotocol/core/ext/skills` — the shared, runtime-neutral surface: `SkillSchema`, `SkillResourceEntrySchema`, `SkillFrontmatterSchema`, `SkillResourcesSchema`, `ListSkillsRequestParamsSchema` / `ListSkillsResultSchema`, `GetSkillRequestParamsSchema` / `GetSkillResultSchema`, `SkillsCapabilitySchema` and the types inferred from them, plus the wire constants (`SKILLS_EXTENSION_ID`, `SKILLS_LIST_METHOD`, `SKILLS_GET_METHOD`, `MAX_SKILL_RESOURCES`, `MAX_SKILL_TOTAL_BYTES`, …) and `skillsCapabilityOf()`. Digests are validated as `sha256:{64 lowercase hex}`, resource lists are capped at the SEP's 512 entries, and `resources` accepts the literal `"dynamic"`.
- `@modelcontextprotocol/client/ext/skills` — `listSkills(client, params?, options?)` and `getSkill(client, params, options?)`, both gated on the server having advertised `io.modelcontextprotocol/skills` **and** `resources` (otherwise `SdkError` / `CapabilityNotSupported`), plus `getSkillsCapability(client)`. `listSkills` is the per-page call: pass a result's `nextCursor` back as `params.cursor`.
- `@modelcontextprotocol/server/ext/skills` — `installSkills(server, { skills, pageSize?, cacheHint? })` declares the extension capability and serves `skills/list` and `skills/get` from caller-provided skill definitions, answering `-32602` for a URI that names no served skill.

The skills result schemas deliberately carry no `resultType` member: the 2026-07-28 era codec validates that discriminator on decode and consumes it before any caller-supplied result schema runs, so a schema that re-declares it can never match (#2789). Regression tests pin this end to end.

This is the metadata surface only. Filesystem discovery, digest-verified resource reads, and `resources/directory/read` (the `directoryRead` capability flag) follow separately.
