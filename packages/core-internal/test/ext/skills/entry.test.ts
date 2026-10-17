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
            'a duplicate file',
            entry({
                resources: [
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 },
                    { uri: 'skill://acme/refunds/SKILL.md', digest, size: 1 }
                ]
            }),
            /more than once/
        ]
    ])('reports %s', (_label, skill, problem) => {
        expect(validateSkillEntry(skill).join('\n')).toMatch(problem);
    });

    it('skillEntryProblems also catches schema violations', () => {
        expect(skillEntryProblems({ uri: 'skill://a/SKILL.md' }).length).toBeGreaterThan(0);
        expect(skillEntryProblems(entry())).toEqual([]);
    });
});

describe('buildSkillEntry', () => {
    it('builds a valid entry with digests computed from the bytes', async () => {
        const manifest = encodeUtf8('﻿---\r\nname: refunds\r\ndescription: Refund workflow.\r\n---\r\nBody\r\n');
        const policy = encodeUtf8('# Policy\n');
        const { skill, problems } = await buildSkillEntry('skill://acme/refunds/SKILL.md', [
            { uri: 'skill://acme/refunds/SKILL.md', bytes: manifest },
            { uri: 'skill://acme/refunds/references/policy.md', bytes: policy }
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
