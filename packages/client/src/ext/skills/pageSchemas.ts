import { ReadResourceDirectoryResultSchema } from '@modelcontextprotocol/core/ext/skills';
import * as z from 'zod/v4';

const cacheFields = {
    ttlMs: z.number().int().nonnegative(),
    cacheScope: z.enum(['public', 'private'])
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

/** The 2026-07-28 result envelopes: each result extends `CacheableResult`, so both caching fields are required. */
export const MODERN_ENVELOPES = { list: SkillsPageSchema, get: GetSkillEnvelopeSchema, directory: ReadResourceDirectoryResultSchema };

const uncached = { ttlMs: true, cacheScope: true } as const;

/** The 2025-11-25 result envelopes: the backport has no caching fields, so they are optional. */
export const LEGACY_ENVELOPES = {
    list: SkillsPageSchema.partial(uncached),
    get: GetSkillEnvelopeSchema.partial(uncached),
    directory: ReadResourceDirectoryResultSchema.partial(uncached)
};
