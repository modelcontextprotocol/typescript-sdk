import { ReadResourceDirectoryResultSchema } from '@modelcontextprotocol/core/ext/skills';
import * as z from 'zod/v4';

const cacheFields = {
    ttlMs: z.number().int().nonnegative().optional(),
    cacheScope: z.enum(['public', 'private']).optional()
};

/**
 * `skills/list` and `skills/get` envelopes that leave entries unchecked, so a
 * bad entry is reported on its own instead of failing the whole response.
 * Defined with this package's own `zod`, so no schema crosses package copies.
 */
const SkillsPageSchema = z.looseObject({
    skills: z.array(z.unknown()),
    nextCursor: z.string().optional(),
    ...cacheFields
});

const GetSkillEnvelopeSchema = z.looseObject({
    skill: z.unknown(),
    ...cacheFields
});

/** The 2025-11-25 result envelopes: the caching fields are optional. */
export const LEGACY_ENVELOPES = { list: SkillsPageSchema, get: GetSkillEnvelopeSchema, directory: ReadResourceDirectoryResultSchema };

const cacheable = { ttlMs: true, cacheScope: true } as const;

/** The 2026-07-28 result envelopes: each result extends `CacheableResult`, so both caching fields are required. */
export const MODERN_ENVELOPES = {
    list: SkillsPageSchema.required(cacheable),
    get: GetSkillEnvelopeSchema.required(cacheable),
    directory: ReadResourceDirectoryResultSchema.required(cacheable)
};
