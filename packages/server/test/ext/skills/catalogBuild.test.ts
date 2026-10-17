import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CatalogBuildOptions } from '../../../src/ext/skills/catalogBuild';
import { buildCatalogSnapshot } from '../../../src/ext/skills/catalogBuild';
import { SkillCatalogError } from '../../../src/ext/skills/errors';
import { memorySkillFiles } from '../../../src/ext/skills/files';
import type { SkillFiles, SkillWarning } from '../../../src/ext/skills/types';
import { ESCALATION, fixtureFiles, GIT, LOGO, PNG, PURCHASE_ORDER, REFUNDS, REMBOURSE } from './fixtures';

function optionsWith(overrides: Partial<CatalogBuildOptions> = {}) {
    const warnings: SkillWarning[] = [];
    const options: CatalogBuildOptions = {
        prefix: [],
        limits: { files: 512, bytes: 16_777_216 },
        strict: false,
        warn: warning => warnings.push(warning),
        ...overrides
    };
    return { warnings, options };
}

const INVALID = '---\nname: other\ndescription: d\n---\n';

describe('buildCatalogSnapshot', () => {
    it('builds flat, URI-sorted entries; a nested skill is also a file of the enclosing skill', async () => {
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith().options);
        expect(snapshot.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        expect(snapshot.skills.get(REFUNDS)?.resources).toEqual(
            expect.arrayContaining([
                { uri: ESCALATION, digest: expect.stringMatching(/^sha256:[\da-f]{64}$/), size: expect.any(Number) },
                { uri: LOGO, digest: `sha256:${createHash('sha256').update(PNG).digest('hex')}`, size: PNG.byteLength }
            ])
        );
    });

    it('skips hidden files and folders', async () => {
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith().options);
        const paths = [...snapshot.files.values()].map(file => file.path);
        expect(paths).toContain('git-workflow/references/REVIEW.md');
        expect(paths.some(path => path.split('/').some(segment => segment.startsWith('.')))).toBe(false);
    });

    it('lists one SKILL.md resource per skill', async () => {
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith().options);
        expect(snapshot.listed).toEqual([
            { uri: REFUNDS, name: 'refunds', description: 'Refund workflow.', mimeType: 'text/markdown', size: expect.any(Number) },
            { uri: ESCALATION, name: 'escalation', description: 'Escalate a refund.', mimeType: 'text/markdown', size: expect.any(Number) },
            {
                uri: GIT,
                name: 'git-workflow',
                description: 'Branching and review conventions.',
                mimeType: 'text/markdown',
                size: expect.any(Number)
            }
        ]);
    });

    it('treats skill roots and folders inside skills as directories, but not organisational folders', async () => {
        const { dirs } = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith().options);
        expect(dirs.has('skill://acme')).toBe(false);
        expect(dirs.has('skill://acme/billing')).toBe(false);
        expect(dirs.get('skill://acme/billing/refunds')?.map(child => [child.name, child.mimeType])).toEqual([
            ['SKILL.md', 'text/markdown'],
            ['assets', 'inode/directory'],
            ['escalation', 'inode/directory'],
            ['templates', 'inode/directory']
        ]);
        expect(dirs.get('skill://acme/billing/refunds/templates')?.map(child => [child.name, child.uri])).toEqual([
            ['Purchase Order.md', PURCHASE_ORDER],
            ['Remboursé.md', REMBOURSE]
        ]);
    });

    it('puts a prefix in front of every URI', async () => {
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith({ prefix: ['shop'] }).options);
        expect(snapshot.ordered.every(skill => skill.uri.startsWith('skill://shop/'))).toBe(true);
    });

    it('skips invalid skills and warns about each one', async () => {
        const files = {
            ...fixtureFiles(),
            'bad/SKILL.md': INVALID,
            'broken/SKILL.md': '---\nname: &a broken\ndescription: d\n---\n',
            'SKILL.md': '---\nname: root\ndescription: d\n---\n',
            'notes/skill.md': '# not a skill'
        };
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(files), options);
        expect(snapshot.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        expect(warnings.map(warning => warning.path).toSorted()).toEqual(['SKILL.md', 'bad/SKILL.md', 'broken/SKILL.md', 'notes/skill.md']);
    });

    it('skips a skill that contains a symlink or other special file', async () => {
        const memory = memorySkillFiles(fixtureFiles());
        const files: SkillFiles = {
            list: async dir => {
                const entries = await memory.list(dir);
                return dir === 'git-workflow' ? [...entries, { name: 'run.sh', kind: 'unsupported' }] : entries;
            },
            read: path => memory.read(path)
        };
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(files, options);
        expect(snapshot.skills.has(GIT)).toBe(false);
        expect(warnings).toContainEqual(expect.objectContaining({ path: 'git-workflow/run.sh' }));
    });

    it('collects every problem into one SkillCatalogError when strict', async () => {
        const files = { ...fixtureFiles(), 'bad/SKILL.md': INVALID, 'SKILL.md': '---\nname: r\ndescription: d\n---\n' };
        const error = await buildCatalogSnapshot(memorySkillFiles(files), optionsWith({ strict: true }).options).catch(
            (error: unknown) => error
        );
        expect(error).toBeInstanceOf(SkillCatalogError);
        expect((error as SkillCatalogError).problems.map(problem => problem.path).toSorted()).toEqual(['SKILL.md', 'bad/SKILL.md']);
    });

    it('publishes an oversized skill with a warning, or fails when strict', async () => {
        const limits = { files: 2, bytes: 16_777_216 };
        const lenient = optionsWith({ limits });
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), lenient.options);
        expect(snapshot.skills.has(REFUNDS)).toBe(true);
        expect(lenient.warnings).toContainEqual({ path: 'acme/billing/refunds', message: expect.stringMatching(/exceeds the limit/) });
        await expect(
            buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith({ limits, strict: true }).options)
        ).rejects.toBeInstanceOf(SkillCatalogError);
    });

    it('always fails on storage errors', async () => {
        const { options } = optionsWith();
        const unlistable: SkillFiles = { list: () => Promise.reject(new Error('EACCES')), read: () => Promise.reject(new Error('unused')) };
        await expect(buildCatalogSnapshot(unlistable, options)).rejects.toBeInstanceOf(SkillCatalogError);
        const memory = memorySkillFiles(fixtureFiles());
        const unreadable: SkillFiles = { list: dir => memory.list(dir), read: () => Promise.reject(new Error('EIO')) };
        await expect(buildCatalogSnapshot(unreadable, options)).rejects.toBeInstanceOf(SkillCatalogError);
    });

    it('warns when no skills are found', async () => {
        const { options, warnings } = optionsWith();
        await buildCatalogSnapshot(memorySkillFiles({}), options);
        expect(warnings).toEqual([{ path: '.', message: expect.stringMatching(/no skills found/) }]);
    });
});

describe('memorySkillFiles', () => {
    it('reads the record on every call and rejects unknown paths', async () => {
        const record: Record<string, string> = { 'a/SKILL.md': 'x' };
        const files = memorySkillFiles(record);
        record['a/extra.md'] = 'y';
        const entries = await files.list('a');
        expect(entries.map(entry => entry.name).toSorted()).toEqual(['SKILL.md', 'extra.md']);
        await expect(files.list('missing')).rejects.toThrow();
        await expect(files.read('a/missing.md')).rejects.toThrow();
    });
});
