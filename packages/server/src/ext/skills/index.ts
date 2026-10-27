// @modelcontextprotocol/server/ext/skills
//
// Server side of the MCP Skills extension (SEP-2640). Adapted, with
// attribution, from the Apache-2.0 `@olaservo/ext-skills` prototype
// (modelcontextprotocol/ext-skills#71), typescript-sdk#2818 and #2972.

export { SkillCatalogError } from './errors';
export { SkillCatalog, SkillsExtension } from './extension';
export { memorySkillFiles } from './files';
export { skillEntry } from './skillEntry';
export type {
    SkillCatalogChanges,
    SkillCatalogOptions,
    SkillFileEntry,
    SkillFiles,
    SkillReadResult,
    SkillsOptions,
    SkillSource,
    SkillSourceOptions,
    SkillWarning
} from './types';
export type {
    DirectoryResource,
    GetSkillResult,
    ListSkillsResult,
    ReadResourceDirectoryResult,
    Skill,
    SkillCacheScope,
    SkillFrontmatter,
    SkillResourceEntry,
    SkillResources,
    SkillsCapability
} from '@modelcontextprotocol/core/ext/skills';
export {
    DIRECTORY_MIME_TYPE,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILL_LIMITS,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from '@modelcontextprotocol/core/ext/skills';
