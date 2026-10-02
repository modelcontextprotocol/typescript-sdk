/**
 * SEP-2640 Skills extension schemas: the validation the wire shapes promise,
 * and the `resultType` posture that typescript-sdk#2789 turns on.
 */
import { describe, expect, it } from 'vitest';

import {
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    MAX_SKILL_RESOURCES,
    SKILLS_EXTENSION_ID,
    SkillFrontmatterSchema,
    SkillResourceEntrySchema,
    SkillSchema,
    skillsCapabilityOf
} from '../../../src/ext/skills';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const SKILL = {
    uri: 'skill://git-workflow/SKILL.md',
    frontmatter: { name: 'git-workflow', description: 'Branching conventions.' },
    resources: [{ uri: 'skill://git-workflow/SKILL.md', digest: DIGEST, size: 128 }]
};

describe('skill resource entries', () => {
    it('accepts a well-formed sha256 digest', () => {
        expect(SkillResourceEntrySchema.safeParse({ uri: 'skill://s/SKILL.md', digest: DIGEST, size: 0 }).success).toBe(true);
    });

    it.each([
        ['no algorithm prefix', 'a'.repeat(64)],
        ['uppercase hex', `sha256:${'A'.repeat(64)}`],
        ['too short', `sha256:${'a'.repeat(63)}`],
        ['wrong algorithm', `sha512:${'a'.repeat(64)}`]
    ])('rejects a digest with %s', (_label, digest) => {
        expect(SkillResourceEntrySchema.safeParse({ uri: 'skill://s/SKILL.md', digest, size: 1 }).success).toBe(false);
    });

    it('requires size to be a non-negative integer', () => {
        expect(SkillResourceEntrySchema.safeParse({ uri: 'u', digest: DIGEST, size: -1 }).success).toBe(false);
        expect(SkillResourceEntrySchema.safeParse({ uri: 'u', digest: DIGEST, size: 1.5 }).success).toBe(false);
    });
});

describe('skill entries', () => {
    it('requires name and description in frontmatter and preserves any further keys verbatim', () => {
        expect(SkillFrontmatterSchema.safeParse({ name: 'n' }).success).toBe(false);
        const parsed = SkillFrontmatterSchema.parse({ name: 'n', description: 'd', 'allowed-tools': ['Bash'] });
        expect(parsed['allowed-tools']).toEqual(['Bash']);
    });

    it('accepts the literal "dynamic" in place of a resource list', () => {
        expect(SkillSchema.safeParse({ ...SKILL, resources: 'dynamic' }).success).toBe(true);
        expect(SkillSchema.safeParse({ ...SKILL, resources: 'whenever' }).success).toBe(false);
    });

    it(`caps a skill at ${MAX_SKILL_RESOURCES} resource entries`, () => {
        const entry = { uri: 'skill://s/f.md', digest: DIGEST, size: 1 };
        expect(SkillSchema.safeParse({ ...SKILL, resources: Array(MAX_SKILL_RESOURCES).fill(entry) }).success).toBe(true);
        expect(SkillSchema.safeParse({ ...SKILL, resources: Array(MAX_SKILL_RESOURCES + 1).fill(entry) }).success).toBe(false);
    });
});

describe('results carry no resultType slot (typescript-sdk#2789)', () => {
    // The 2026-07-28 era codec validates `resultType` on decode and CONSUMES it
    // before any caller-supplied result schema runs. A schema that re-declares
    // it can therefore never match. These pin that the skills results parse a
    // body with no `resultType` at all.
    it('parses a skills/list body with no resultType', () => {
        const parsed = ListSkillsResultSchema.parse({ skills: [SKILL], ttlMs: 60_000, cacheScope: 'public' });
        expect(parsed.skills).toHaveLength(1);
        expect(parsed.nextCursor).toBeUndefined();
    });

    it('parses a skills/get body with no resultType', () => {
        expect(GetSkillResultSchema.parse({ skill: SKILL }).skill.uri).toBe(SKILL.uri);
    });

    it('rejects an unknown cacheScope rather than passing it through', () => {
        expect(ListSkillsResultSchema.safeParse({ skills: [], cacheScope: 'shared' }).success).toBe(false);
    });
});

describe('pagination params', () => {
    it('accepts an absent cursor and a string cursor', () => {
        expect(ListSkillsRequestParamsSchema.safeParse({}).success).toBe(true);
        expect(ListSkillsRequestParamsSchema.parse({ cursor: '2' }).cursor).toBe('2');
        expect(ListSkillsRequestParamsSchema.safeParse({ cursor: 2 }).success).toBe(false);
    });
});

describe('capability negotiation', () => {
    it('reads the extension out of advertised capabilities', () => {
        expect(skillsCapabilityOf({ extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } })).toEqual({ directoryRead: true });
        expect(skillsCapabilityOf({ extensions: { [SKILLS_EXTENSION_ID]: {} } })).toEqual({});
    });

    it('returns undefined when the extension is absent, and for a malformed value', () => {
        expect(skillsCapabilityOf(undefined)).toBeUndefined();
        expect(skillsCapabilityOf({ extensions: {} })).toBeUndefined();
        expect(skillsCapabilityOf({ extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: 'yes' } } })).toBeUndefined();
    });

    it('preserves capability fields added by later revisions', () => {
        expect(skillsCapabilityOf({ extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: false, future: 1 } } })).toEqual({
            directoryRead: false,
            future: 1
        });
    });
});
