import { createHash } from 'node:crypto';

import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { describe, expect, it } from 'vitest';

import { encodeUtf8 } from '../../../src/ext/skills/bytes';
import { buildSkillEntry, skillEntryProblems, validateSkillEntry } from '../../../src/ext/skills/entry';

const digest = `sha256:${'a'.repeat(64)}`;
const entry = (overrides: Partial<Skill> = {}): Skill => ({
    uri: 'skill://acme/refunds/SKILL.md',
    frontmatter: { name: 'refunds', description: 'Refund workflow.' },
    resources: [
        { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
        { uri: 'skill://acme/refunds/references/policy.md', digest, size: 1 }
    ],
    ...overrides
});

describe('validateSkillEntry', () => {
    it('accepts a valid entry and a dynamic one', () => {
        expect(validateSkillEntry(entry())).toEqual([]);
        expect(validateSkillEntry(entry({ resources: 'dynamic' }))).toEqual([]);
    });

    it.each([
        ['a URI not ending in /SKILL.md', entry({ uri: 'skill://acme/refunds/README.md' }), /must be a URI ending in \/SKILL\.md/],
        [
            'an empty segment before SKILL.md',
            entry({ uri: 'skill://acme//SKILL.md', frontmatter: { name: 'acme', description: 'd' }, resources: 'dynamic' }),
            /must be a URI ending in \/SKILL\.md/
        ],
        [
            'a name that does not match its folder',
            entry({ frontmatter: { name: 'refund', description: 'd' } }),
            /must match the last path segment/
        ],
        ['an invalid name', entry({ frontmatter: { name: 'Refunds', description: 'd' } }), /lowercase/],
        ['an empty description', entry({ frontmatter: { name: 'refunds', description: '' } }), /description/],
        ['a non-string metadata value', entry({ frontmatter: { name: 'refunds', description: 'd', metadata: { v: 1 } } }), /metadata/],
        ['a missing SKILL.md entry', entry({ resources: [{ uri: 'skill://acme/refunds/x.md', digest, size: 1 }] }), /must include/],
        [
            'a file outside the skill',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/other/x.md', digest, size: 1 }
                ]
            }),
            /outside the skill/
        ],
        [
            'an escaping file',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/../other/x.md', digest, size: 1 }
                ]
            }),
            /outside the skill/
        ],
        [
            'a file whose segment decodes to a traversal',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/x%2F..%2F..%2Fother%2Fx.md', digest, size: 1 }
                ]
            }),
            /outside the skill/
        ],
        [
            'a duplicate file',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 }
                ]
            }),
            /more than once/
        ],
        [
            'a file listed again under another percent-encoding',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/Q&A.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/Q%26A.md', digest, size: 1 }
                ]
            }),
            /"skill:\/\/acme\/refunds\/Q%26A\.md" is listed more than once/
        ]
    ])('reports %s', (_label, skill, problem) => {
        expect(validateSkillEntry(skill).join('\n')).toMatch(problem);
    });

    it.each(['policy.md#part', 'policy.md#', 'policy.md?v=1', 'policy.md?'])('reports a file URI with a query or fragment (%s)', suffix => {
        const skill = entry({
            resources: [
                { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                { uri: `skill://acme/refunds/references/${suffix}`, digest, size: 1 }
            ]
        });
        expect(validateSkillEntry(skill)).toEqual([
            `resource "skill://acme/refunds/references/${suffix}" must not have a query or fragment`
        ]);
    });

    it('counts the length limits in characters, not UTF-16 code units', () => {
        const problems = (fields: Record<string, string>) =>
            validateSkillEntry(entry({ frontmatter: { name: 'refunds', description: 'd', ...fields } })).join('\n');
        expect(problems({ description: '😀'.repeat(1024), compatibility: '😀'.repeat(500) })).toBe('');
        expect(problems({ description: '😀'.repeat(1025) })).toMatch(/description/);
        expect(problems({ compatibility: '😀'.repeat(501) })).toMatch(/compatibility/);
    });

    it('skillEntryProblems also catches schema violations', () => {
        expect(skillEntryProblems({ uri: 'skill://a/SKILL.md' }).length).toBeGreaterThan(0);
        expect(skillEntryProblems(entry())).toEqual([]);
    });
});

describe('buildSkillEntry', () => {
    it('builds a valid entry with digests computed from the bytes, sorted by URI', async () => {
        const manifest = encodeUtf8('\uFEFF---\r\nname: refunds\r\ndescription: Refund workflow.\r\n---\r\nBody\r\n');
        const policy = encodeUtf8('# Policy\n');
        // Reverse code-unit order on purpose, so the output order proves the sort.
        const { skill, problems } = await buildSkillEntry('skill://acme/refunds/SKILL.md', [
            { uri: 'skill://acme/refunds/references/policy.md', bytes: policy },
            { uri: 'skill://acme/refunds/SKILL.md', bytes: manifest }
        ]);
        expect(problems).toEqual([]);
        expect(skill?.frontmatter).toEqual({ name: 'refunds', description: 'Refund workflow.' });
        expect(skill?.resources).toEqual([
            {
                uri: 'skill://acme/refunds/SKILL.md',
                digest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
                size: manifest.byteLength
            },
            {
                uri: 'skill://acme/refunds/references/policy.md',
                digest: `sha256:${createHash('sha256').update(policy).digest('hex')}`,
                size: policy.byteLength
            }
        ]);
    });

    it('reports invalid UTF-8, bad frontmatter and missing fields', async () => {
        const uri = 'skill://acme/refunds/SKILL.md';
        expect(await buildSkillEntry(uri, [{ uri, bytes: Uint8Array.from([0xff]) }])).toEqual({
            problems: ['SKILL.md is not valid UTF-8']
        });
        expect(await buildSkillEntry(uri, [{ uri, bytes: encodeUtf8('---\nname: &a refunds\n---\n') }])).toMatchObject({
            problems: [expect.stringMatching(/frontmatter/)]
        });
        expect(await buildSkillEntry(uri, [{ uri, bytes: encodeUtf8('---\nname: refunds\n---\n') }])).toMatchObject({
            problems: [expect.stringMatching(/"name" and "description"/)]
        });
    });
});
