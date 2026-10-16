// @modelcontextprotocol/core/ext/skills
//
// Shared surface for the MCP Skills extension (SEP-2640): Zod schemas, the
// TypeScript types inferred from them, wire constants, and the runtime-neutral
// capability helper both roles use.
//
// Runtime-neutral by construction — `zod/v4` and the core schema modules are
// the only imports, so this subpath is safe in browser and Workers bundles.
// The client operations live at `@modelcontextprotocol/client/ext/skills` and
// the server handlers at `@modelcontextprotocol/server/ext/skills`.

export type { CapabilitiesWithExtensions } from './capability';
export { skillsCapabilityOf } from './capability';
export {
    MAX_SKILL_RESOURCES,
    MAX_SKILL_TOTAL_BYTES,
    SKILL_DIGEST_PATTERN,
    SKILL_MANIFEST_FILENAME,
    SKILL_URI_SCHEME,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from './constants';
export {
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    SkillCacheScopeSchema,
    SkillDigestSchema,
    SkillFrontmatterSchema,
    SkillResourceEntrySchema,
    SkillResourcesSchema,
    SkillsCapabilitySchema,
    SkillSchema
} from './schemas';
export type {
    GetSkillRequestParams,
    GetSkillResult,
    ListSkillsRequestParams,
    ListSkillsResult,
    Skill,
    SkillCacheScope,
    SkillFrontmatter,
    SkillResourceEntry,
    SkillResources,
    SkillsCapability
} from './types';
