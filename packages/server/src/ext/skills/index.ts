/**
 * `@modelcontextprotocol/server/ext/skills` — the server side of the MCP
 * Skills extension (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * `SkillsExtension` owns the wire: capability, `skills/list`, `skills/get`
 * and `resources/directory/read`. A `SkillSource` owns the catalog. Skill
 * files are ordinary resources; `skillResourceOf` computes the digest and
 * size an entry lists for each.
 */

export type { ReadResourceDirectoryPage, SkillsExtensionOptions, SkillSource } from './skillsExtension';
export { SkillsExtension } from './skillsExtension';
export type {
    GetSkillParams,
    GetSkillResult,
    ListSkillsParams,
    ListSkillsResult,
    ReadResourceDirectoryParams,
    ReadResourceDirectoryResult,
    Skill,
    SkillFrontmatter,
    SkillResource,
    SkillsCacheScope,
    SkillsExtensionCapability
} from '@modelcontextprotocol/core-internal/ext/skills';
export {
    getSkillParamsSchema,
    getSkillResultSchema,
    listSkillsParamsSchema,
    listSkillsResultSchema,
    readResourceDirectoryParamsSchema,
    readResourceDirectoryResultSchema,
    skillFrontmatterSchema,
    skillResourceSchema,
    skillSchema,
    skillsExtensionCapabilitySchema
} from '@modelcontextprotocol/core-internal/ext/skills';
export {
    DIRECTORY_MIME_TYPE,
    MAX_SKILL_RESOURCES,
    MAX_SKILL_TOTAL_BYTES,
    SKILL_MANIFEST_FILENAME,
    skillDigest,
    skillResourceOf,
    SKILLS_EXTENSION_ID
} from '@modelcontextprotocol/core-internal/ext/skills';
