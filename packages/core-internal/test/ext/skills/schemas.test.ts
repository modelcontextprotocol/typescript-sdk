import { describe, expect, it } from 'vitest';

import { MAX_SKILL_RESOURCES, skillResourceOf, skillSchema } from '../../../src/ext/skills/index';

const URI = 'skill://acme/billing/refunds/SKILL.md';
const frontmatter = { name: 'refunds', description: 'Process customer refund requests', license: 'Apache-2.0' };
const manifest = await skillResourceOf(URI, '---\nname: refunds\n---\n');

describe('skillSchema', () => {
    it('accepts a static entry, keeping every frontmatter field', () => {
        const parsed = skillSchema.parse({ uri: URI, frontmatter, resources: [manifest] });
        expect(parsed.frontmatter).toEqual(frontmatter);
    });

    it('accepts "dynamic" resources', () => {
        expect(skillSchema.safeParse({ uri: URI, frontmatter, resources: 'dynamic' }).success).toBe(true);
    });

    it('does not cap resources at the spec baseline, which hosts may exceed', () => {
        const extra = Array.from({ length: MAX_SKILL_RESOURCES }, (_, i) => ({
            ...manifest,
            uri: `skill://acme/billing/refunds/f${i}.md`
        }));
        expect(skillSchema.safeParse({ uri: URI, frontmatter, resources: [manifest, ...extra] }).success).toBe(true);
    });

    it.each([
        ['a uri that does not name SKILL.md', { uri: 'skill://acme/billing/refunds', resources: [manifest] }],
        ['a final path segment other than frontmatter.name', { uri: 'skill://acme/billing/refund/SKILL.md', resources: 'dynamic' }],
        ['resources without the SKILL.md', { uri: URI, resources: [] }],
        ['a resource outside the skill directory', { uri: URI, resources: [manifest, { ...manifest, uri: 'skill://acme/other.md' }] }],
        ['a digest not in sha256:{hex} form', { uri: URI, resources: [{ ...manifest, digest: manifest.digest.toUpperCase() }] }],
        ['resources missing entirely', { uri: URI }]
    ])('rejects %s', (_, entry) => {
        expect(skillSchema.safeParse({ frontmatter, ...entry }).success).toBe(false);
    });
});
