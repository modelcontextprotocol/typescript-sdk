import * as z from 'zod/v4';

import { BaseRequestParamsSchema, PaginatedRequestParamsSchema, PaginatedResultSchema, ResourceSchema, ResultSchema } from '../../schemas';
import { SKILL_DIGEST_PATTERN } from './constants';

// Every object schema here is loose: none of the stable spec's types declare
// `additionalProperties: false`, so unknown keys (including `_meta`) survive.

export const SkillDigestSchema = z
    .string()
    .regex(SKILL_DIGEST_PATTERN, 'digest must be "sha256:" followed by 64 lowercase hexadecimal characters');

export const SkillResourceEntrySchema = z.looseObject({
    /** Resource URI of the file. */
    uri: z.string(),
    /** SHA-256 digest of the file's raw bytes. */
    digest: SkillDigestSchema,
    /** Length of the file's raw bytes. */
    size: z.number().int().nonnegative()
});

export const SkillFrontmatterSchema = z
    .looseObject({
        name: z.string(),
        description: z.string()
    })
    // Zod copies an own `__proto__` field by assignment, which makes it the prototype: fields no key listing shows.
    .refine(frontmatter => Object.getPrototypeOf(frontmatter) === Object.prototype, 'frontmatter must not have a "__proto__" field');

export const SkillResourcesSchema = z.union([z.array(SkillResourceEntrySchema), z.literal('dynamic')]);

export const SkillSchema = z.looseObject({
    /** Resource URI of the skill's `SKILL.md`. */
    uri: z.string(),
    /** The `SKILL.md` frontmatter, verbatim. */
    frontmatter: SkillFrontmatterSchema,
    /** Every file of the skill, or `"dynamic"`. */
    resources: SkillResourcesSchema,
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const SkillCacheScopeSchema = z.enum(['public', 'private']);

// Required, as the stable spec (2026-07-28) defines them; only SkillsClient reads the 2025-11-25 backport, which has none.
const cacheFields = {
    ttlMs: z.number().int().nonnegative(),
    cacheScope: SkillCacheScopeSchema
};

export const ListSkillsResultSchema = z.looseObject({
    ...PaginatedResultSchema.shape,
    skills: z.array(SkillSchema),
    ...cacheFields
});

export const GetSkillRequestParamsSchema = BaseRequestParamsSchema.extend({
    /** The `SKILL.md` URI of the skill to fetch. */
    uri: z.string()
});

export const GetSkillResultSchema = z.looseObject({
    ...ResultSchema.shape,
    skill: SkillSchema,
    ...cacheFields
});

export const DirectoryResourceSchema = z.looseObject(ResourceSchema.shape);

export const ReadResourceDirectoryRequestParamsSchema = PaginatedRequestParamsSchema.extend({
    /** URI of the directory resource to read. */
    uri: z.string()
});

export const ReadResourceDirectoryResultSchema = z.looseObject({
    ...PaginatedResultSchema.shape,
    resources: z.array(DirectoryResourceSchema),
    ...cacheFields
});

export const SkillsCapabilitySchema = z.looseObject({
    /** Whether the server serves `resources/directory/read`. */
    directoryRead: z.boolean().optional()
});

export { PaginatedRequestParamsSchema as ListSkillsRequestParamsSchema } from '../../schemas';
