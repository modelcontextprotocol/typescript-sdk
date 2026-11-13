// @modelcontextprotocol/core/ext/skills
//
// Shared surface of the MCP Skills extension (SEP-2640): wire constants, Zod
// schemas, the types inferred from them, and the capability reader. Adapted,
// with attribution, from the Apache-2.0 `@olaservo/ext-skills` prototype
// (modelcontextprotocol/ext-skills#71) and typescript-sdk#2818.

export type { CapabilitiesWithExtensions } from './capability';
export { skillsCapabilityOf } from './capability';
export {
    DIRECTORY_MIME_TYPE,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILL_DIGEST_PATTERN,
    SKILL_LIMITS,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from './constants';
export {
    DirectoryResourceSchema,
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    ReadResourceDirectoryRequestParamsSchema,
    ReadResourceDirectoryResultSchema,
    SkillCacheScopeSchema,
    SkillDigestSchema,
    SkillFrontmatterSchema,
    SkillResourceEntrySchema,
    SkillResourcesSchema,
    SkillsCapabilitySchema,
    SkillSchema
} from './schemas';
export type {
    DirectoryResource,
    GetSkillRequestParams,
    GetSkillResult,
    ListSkillsRequestParams,
    ListSkillsResult,
    ReadResourceDirectoryRequestParams,
    ReadResourceDirectoryResult,
    Skill,
    SkillCacheScope,
    SkillFrontmatter,
    SkillResourceEntry,
    SkillResources,
    SkillsCapability
} from './types';
