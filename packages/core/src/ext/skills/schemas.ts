import * as z from 'zod/v4';

import { BaseRequestParamsSchema, PaginatedResultSchema, ResultSchema } from '../../schemas';
import { MAX_SKILL_RESOURCES, SKILL_DIGEST_PATTERN } from './constants';

/**
 * Zod schemas for the MCP Skills extension (SEP-2640).
 *
 * Adapted, with attribution, from the Apache-2.0 `@olaservo/ext-skills`
 * prototype (modelcontextprotocol/ext-skills#71); the shapes here follow the
 * final SEP rather than the prototype's earlier vocabulary.
 *
 * Note on `resultType`: the result schemas below extend the neutral
 * {@linkcode ResultSchema} / {@linkcode PaginatedResultSchema} and therefore carry
 * NO `resultType` member. `resultType` is wire-only vocabulary owned by the
 * 2026-07-28 era codec, which validates it on decode and consumes it before a
 * caller-supplied result schema ever sees the value. A result schema that
 * re-declares it can never match (typescript-sdk#2789).
 */

/**
 * A SHA-256 content digest over a skill file's raw bytes, formatted
 * `sha256:{64 lowercase hex}`.
 */
export const SkillDigestSchema = z.string().regex(SKILL_DIGEST_PATTERN, 'digest must be formatted "sha256:{64 lowercase hex chars}"');

/** One file belonging to a skill, with the material a host needs to verify it. */
export const SkillResourceEntrySchema = z.object({
    /** Resource URI of the file. */
    uri: z.string(),
    /** SHA-256 digest of the file's raw bytes. */
    digest: SkillDigestSchema,
    /** The file's length in bytes. */
    size: z.number().int().nonnegative()
});

/**
 * The YAML frontmatter of a skill's `SKILL.md`, converted to JSON verbatim.
 * `name` and `description` are the required minimum; any further keys the
 * author wrote are preserved.
 */
export const SkillFrontmatterSchema = z.looseObject({
    name: z.string(),
    description: z.string()
});

/**
 * A skill's file set: either the complete list of entries, or the literal
 * `"dynamic"` for servers that generate content per request and therefore
 * cannot publish digests up front.
 */
export const SkillResourcesSchema = z.union([z.array(SkillResourceEntrySchema).max(MAX_SKILL_RESOURCES), z.literal('dynamic')]);

/** A single skill served by an MCP server. */
export const SkillSchema = z.object({
    /** Resource URI of the skill's `SKILL.md`. */
    uri: z.string(),
    /** The manifest's frontmatter, verbatim. */
    frontmatter: SkillFrontmatterSchema,
    /** The skill's files, or `"dynamic"`. */
    resources: SkillResourcesSchema
});

/** Whether a result may be cached by shared caches (`public`) or only by the requesting client (`private`). */
export const SkillCacheScopeSchema = z.enum(['public', 'private']);

/**
 * Cache freshness hints carried on skills results from protocol revision
 * 2026-07-28 onward. Optional so that a single schema serves both eras.
 */
const skillCacheHintShape = {
    /** Milliseconds after which the result should be refreshed. */
    ttlMs: z.number().int().nonnegative().optional(),
    /** Cache scope for the result. */
    cacheScope: SkillCacheScopeSchema.optional()
};

/** Result of `skills/list`. */
export const ListSkillsResultSchema = PaginatedResultSchema.extend({
    skills: z.array(SkillSchema),
    ...skillCacheHintShape
});

/** Params for `skills/get`. */
export const GetSkillRequestParamsSchema = BaseRequestParamsSchema.extend({
    /** The `SKILL.md` URI of the skill to fetch. */
    uri: z.string()
});

/** Result of `skills/get`. */
export const GetSkillResultSchema = ResultSchema.extend({
    skill: SkillSchema,
    ...skillCacheHintShape
});

/**
 * The value a server publishes at
 * `capabilities.extensions["io.modelcontextprotocol/skills"]`.
 *
 * Loose so that capability fields added by later revisions of the extension
 * survive a round trip instead of being stripped.
 */
export const SkillsCapabilitySchema = z.looseObject({
    /** Whether the server also serves `resources/directory/read`. Defaults to `false`. */
    directoryRead: z.boolean().optional()
});

/** Params for `skills/list` — standard MCP list pagination, no extra fields. */
export { PaginatedRequestParamsSchema as ListSkillsRequestParamsSchema } from '../../schemas';
