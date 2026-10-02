import type * as z from 'zod/v4';

import type {
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    SkillCacheScopeSchema,
    SkillFrontmatterSchema,
    SkillResourceEntrySchema,
    SkillResourcesSchema,
    SkillsCapabilitySchema,
    SkillSchema
} from './schemas';

/** One file belonging to a skill, with the material a host needs to verify it. */
export type SkillResourceEntry = z.infer<typeof SkillResourceEntrySchema>;

/** The YAML frontmatter of a skill's `SKILL.md`, converted to JSON verbatim. */
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** A skill's file set: the complete list of entries, or the literal `"dynamic"`. */
export type SkillResources = z.infer<typeof SkillResourcesSchema>;

/** A single skill served by an MCP server. */
export type Skill = z.infer<typeof SkillSchema>;

/** Whether a result may be cached by shared caches (`public`) or only by the requesting client (`private`). */
export type SkillCacheScope = z.infer<typeof SkillCacheScopeSchema>;

/** Params for `skills/list`. */
export type ListSkillsRequestParams = z.infer<typeof ListSkillsRequestParamsSchema>;

/** Result of `skills/list`. */
export type ListSkillsResult = z.infer<typeof ListSkillsResultSchema>;

/** Params for `skills/get`. */
export type GetSkillRequestParams = z.infer<typeof GetSkillRequestParamsSchema>;

/** Result of `skills/get`. */
export type GetSkillResult = z.infer<typeof GetSkillResultSchema>;

/** The value published at `capabilities.extensions["io.modelcontextprotocol/skills"]`. */
export type SkillsCapability = z.infer<typeof SkillsCapabilitySchema>;
