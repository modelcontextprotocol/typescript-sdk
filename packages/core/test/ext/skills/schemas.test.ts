import { describe, expect, it } from 'vitest';

import {
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsResultSchema,
    ReadResourceDirectoryRequestParamsSchema,
    ReadResourceDirectoryResultSchema,
    SKILL_LIMITS,
    SKILLS_EXTENSION_ID,
    skillsCapabilityOf,
    SkillSchema
} from '../../../src/ext/skills/index';

const digest = `sha256:${'a'.repeat(64)}`;
const skill = (extra: Record<string, unknown> = {}) => ({
    uri: 'skill://git-workflow/SKILL.md',
    frontmatter: { name: 'git-workflow', description: 'Branching and review conventions.' },
    resources: [{ uri: 'skill://git-workflow/SKILL.md', digest, size: 10 }],
    ...extra
});

describe('SkillSchema', () => {
    it('keeps _meta and unknown keys', () => {
        const parsed = SkillSchema.parse(skill({ _meta: { 'io.modelcontextprotocol.skills/x': 1 }, future: true }));
        expect(parsed._meta).toEqual({ 'io.modelcontextprotocol.skills/x': 1 });
        expect((parsed as Record<string, unknown>)['future']).toBe(true);
    });

    it('keeps frontmatter fields beyond name and description', () => {
        const parsed = SkillSchema.parse(skill({ frontmatter: { name: 'git-workflow', description: 'd', license: 'MIT' } }));
        expect(parsed.frontmatter).toEqual({ name: 'git-workflow', description: 'd', license: 'MIT' });
    });

    it('rejects a frontmatter "__proto__" field, which would otherwise become the prototype', () => {
        for (const value of ['{"allowed-tools":"Bash(*)"}', 'null']) {
            const frontmatter: unknown = JSON.parse(`{"name":"git-workflow","description":"d","__proto__":${value}}`);
            const result = SkillSchema.safeParse(skill({ frontmatter }));
            expect(result.success).toBe(false);
            expect(result.error?.issues).toEqual([
                expect.objectContaining({ path: ['frontmatter'], message: expect.stringContaining('__proto__') })
            ]);
        }
    });

    it('accepts more files than SKILL_LIMITS (limits are policy, not schema)', () => {
        const resources = Array.from({ length: SKILL_LIMITS.files + 1 }, (_, index) => ({
            uri: `skill://git-workflow/f${index}`,
            digest,
            size: 1
        }));
        expect(SkillSchema.safeParse(skill({ resources })).success).toBe(true);
    });

    it('accepts "dynamic" and rejects any other string', () => {
        expect(SkillSchema.safeParse(skill({ resources: 'dynamic' })).success).toBe(true);
        expect(SkillSchema.safeParse(skill({ resources: 'static' })).success).toBe(false);
    });

    it('rejects malformed digests and negative sizes', () => {
        expect(
            SkillSchema.safeParse(skill({ resources: [{ uri: 'skill://git-workflow/SKILL.md', digest: 'sha256:ABC', size: 1 }] })).success
        ).toBe(false);
        expect(SkillSchema.safeParse(skill({ resources: [{ uri: 'skill://git-workflow/SKILL.md', digest, size: -1 }] })).success).toBe(
            false
        );
    });
});

describe('result schemas', () => {
    it('ListSkillsResult keeps paging and caching fields and needs no resultType', () => {
        const parsed = ListSkillsResultSchema.parse({ skills: [skill()], nextCursor: 'c', ttlMs: 5, cacheScope: 'public' });
        expect(parsed).toMatchObject({ nextCursor: 'c', ttlMs: 5, cacheScope: 'public' });
    });

    it('GetSkillResult carries one entry', () => {
        expect(GetSkillResultSchema.parse({ skill: skill(), ttlMs: 0, cacheScope: 'private' }).skill.uri).toBe(
            'skill://git-workflow/SKILL.md'
        );
    });

    it('ReadResourceDirectoryResult keeps unknown keys on children and caching fields', () => {
        const parsed = ReadResourceDirectoryResultSchema.parse({
            resources: [{ uri: 'skill://git-workflow/references', name: 'references', mimeType: 'inode/directory', extra: 1 }],
            ttlMs: 0,
            cacheScope: 'private'
        });
        expect((parsed.resources[0] as Record<string, unknown>)['extra']).toBe(1);
        expect(parsed.ttlMs).toBe(0);
    });

    it.each([
        ['ListSkillsResult', ListSkillsResultSchema, { skills: [skill()] }],
        ['GetSkillResult', GetSkillResultSchema, { skill: skill() }],
        ['ReadResourceDirectoryResult', ReadResourceDirectoryResultSchema, { resources: [] }]
    ] as const)('%s requires ttlMs and cacheScope, as the stable spec does', (_, schema, body) => {
        expect(schema.safeParse({ ...body, cacheScope: 'private' }).success).toBe(false);
        expect(schema.safeParse({ ...body, ttlMs: 0 }).success).toBe(false);
        expect(schema.safeParse({ ...body, ttlMs: 0, cacheScope: 'private' }).success).toBe(true);
    });
});

describe('request params', () => {
    it('skills/get requires a uri', () => {
        expect(GetSkillRequestParamsSchema.safeParse({}).success).toBe(false);
        expect(GetSkillRequestParamsSchema.parse({ uri: 'skill://a/SKILL.md' }).uri).toBe('skill://a/SKILL.md');
    });

    it('resources/directory/read takes a uri and an optional cursor', () => {
        expect(ReadResourceDirectoryRequestParamsSchema.parse({ uri: 'skill://a', cursor: 'x' })).toMatchObject({
            uri: 'skill://a',
            cursor: 'x'
        });
    });
});

describe('constants and capability', () => {
    it('SKILL_LIMITS matches the SEP', () => {
        expect(SKILL_LIMITS).toEqual({ files: 512, bytes: 16_777_216 });
    });

    it('skillsCapabilityOf reads the extension entry', () => {
        expect(skillsCapabilityOf({ extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } })).toEqual({ directoryRead: true });
        expect(skillsCapabilityOf({ extensions: {} })).toBeUndefined();
        expect(skillsCapabilityOf(undefined)).toBeUndefined();
    });
});
