/**
 * `@modelcontextprotocol/client/ext/skills` — the client side of the MCP
 * Skills extension (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * `SkillsClientExtension` wraps `skills/list`, `skills/get` and
 * `resources/directory/read`, and reads skill files verified against their
 * entry's digest and size.
 */

export { SkillsClientExtension } from './skillsClientExtension';
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
