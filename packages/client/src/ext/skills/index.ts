// @modelcontextprotocol/client/ext/skills
//
// Host side of the MCP Skills extension (SEP-2640). Adapted, with
// attribution, from the Apache-2.0 `@olaservo/ext-skills` prototype
// (modelcontextprotocol/ext-skills#71), typescript-sdk#2818 and #2972.

export type { InvalidSkillEntry } from './entries';
export type { SkillVerificationReason } from './errors';
export { SkillVerificationError } from './errors';
export type { SkillFile, SkillListing, SkillsClientOptions } from './skillsClient';
export { SkillsClient } from './skillsClient';
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
