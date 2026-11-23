import type * as z from 'zod/v4';

import type {
    DirectoryResourceSchema,
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    ReadResourceDirectoryRequestParamsSchema,
    ReadResourceDirectoryResultSchema,
    SkillCacheScopeSchema,
    SkillFrontmatterSchema,
    SkillResourceEntrySchema,
    SkillResourcesSchema,
    SkillsCapabilitySchema,
    SkillSchema
} from './schemas';

/** One file of a skill, with what a host needs to verify it. */
export type SkillResourceEntry = z.infer<typeof SkillResourceEntrySchema>;
/** A skill's `SKILL.md` frontmatter as JSON, verbatim. */
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
/** A skill's complete file list, or `"dynamic"`. */
export type SkillResources = z.infer<typeof SkillResourcesSchema>;
/** One skill entry, as `skills/list` and `skills/get` carry it. */
export type Skill = z.infer<typeof SkillSchema>;
/** `public` or `private`. */
export type SkillCacheScope = z.infer<typeof SkillCacheScopeSchema>;
/** Params of `skills/list`. */
export type ListSkillsRequestParams = z.infer<typeof ListSkillsRequestParamsSchema>;
/** Result of `skills/list`. */
export type ListSkillsResult = z.infer<typeof ListSkillsResultSchema>;
/** Params of `skills/get`. */
export type GetSkillRequestParams = z.infer<typeof GetSkillRequestParamsSchema>;
/** Result of `skills/get`. */
export type GetSkillResult = z.infer<typeof GetSkillResultSchema>;
/** A child of a directory resource. */
export type DirectoryResource = z.infer<typeof DirectoryResourceSchema>;
/** Params of `resources/directory/read`. */
export type ReadResourceDirectoryRequestParams = z.infer<typeof ReadResourceDirectoryRequestParamsSchema>;
/** Result of `resources/directory/read`. */
export type ReadResourceDirectoryResult = z.infer<typeof ReadResourceDirectoryResultSchema>;
/** The value at `capabilities.extensions["io.modelcontextprotocol/skills"]`. */
export type SkillsCapability = z.infer<typeof SkillsCapabilitySchema>;
