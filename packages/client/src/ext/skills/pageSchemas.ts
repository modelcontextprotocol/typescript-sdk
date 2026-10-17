import * as z from 'zod/v4';

/**
 * `skills/list` and `skills/get` envelopes that leave entries unchecked, so a
 * bad entry is reported on its own instead of failing the whole response.
 * Defined with this package's own `zod`, so no schema crosses package copies.
 */
export const SkillsPageSchema = z.looseObject({
    skills: z.array(z.unknown()),
    nextCursor: z.string().optional(),
    ttlMs: z.number().int().nonnegative().optional(),
    cacheScope: z.enum(['public', 'private']).optional()
});

export const GetSkillEnvelopeSchema = z.looseObject({
    skill: z.unknown()
});
