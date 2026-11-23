import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CatalogBuildOptions } from '../../../src/ext/skills/catalogBuild';
import { buildCatalogSnapshot } from '../../../src/ext/skills/catalogBuild';
import { SkillCatalogError } from '../../../src/ext/skills/errors';
import { memorySkillFiles } from '../../../src/ext/skills/files';
import type { SkillFileEntry, SkillFiles, SkillWarning } from '../../../src/ext/skills/types';
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

/** The problems a strict build fails with, sorted by path; `[]` when it succeeds. Any other error fails the test. */
async function strictProblems(files: SkillFiles, overrides: Partial<CatalogBuildOptions> = {}): Promise<SkillWarning[]> {
    try {
        await buildCatalogSnapshot(files, optionsWith({ ...overrides, strict: true }).options);
        return [];
    } catch (error) {
        if (error instanceof SkillCatalogError) return error.problems.toSorted(byPath);
        throw error;
    }
}

/** `files` plus extra entries in some directories, the way a disk adapter reports symlinks and empty folders. */
function withEntries(files: SkillFiles, extra: Record<string, SkillFileEntry[]>): SkillFiles {
    return {
        async list(dir) {
            if (!Object.hasOwn(extra, dir)) return files.list(dir);
            const existing = await files.list(dir).catch((): SkillFileEntry[] => []);
            return [...existing, ...extra[dir]!];
        },
        read: path => files.read(path)
    };
}

const byPath = (a: SkillWarning, b: SkillWarning): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const names = (entries: readonly SkillFileEntry[]): string[] => entries.map(entry => entry.name).toSorted();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const INVALID = `---
name: other
description: d
---
`;
const NOT_FOLLOWED = /symlinks and other special files are not followed; copy the file instead/;
const UNREPRESENTABLE = /cannot be represented in a URI/;

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

    it('publishes reserved characters in names as a host resolves the plain name', async () => {
        const names = ['Q&A.md', 'c++.md', '[draft].md', 'me@home.md'];
        const files = {
            ...fixtureFiles(),
            ...Object.fromEntries([...names, '100%.md'].map(name => [`git-workflow/references/${name}`, '# x\n']))
        };
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(files), optionsWith().options);
        const resources = snapshot.skills.get(GIT)?.resources;
        const uris = resources === undefined || resources === 'dynamic' ? [] : resources.map(resource => resource.uri);
        for (const name of names) expect(uris).toContain(new URL(`references/${name}`, 'skill://git-workflow/').href);
        // `%` is always encoded: a raw one would read as the start of an escape.
        expect(uris).toContain('skill://git-workflow/references/100%25.md');
    });

    it('puts a prefix in front of every URI', async () => {
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), optionsWith({ prefix: ['shop'] }).options);
        expect(snapshot.ordered.every(skill => skill.uri.startsWith('skill://shop/'))).toBe(true);
    });

    it('encodes a top-level folder strictly, since it is the URI authority', async () => {
        const files = {
            'me@home/refunds/SKILL.md': `---
name: refunds
description: d
---
`,
            'me@home/refunds/references/Q&A.md': '# Q&A\n',
            '[draft]/notes/SKILL.md': `---
name: notes
description: d
---
`
        };
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(files), options);
        expect(warnings).toEqual([]);
        const uris = snapshot.ordered.map(skill => skill.uri);
        expect(uris).toEqual(['skill://%5Bdraft%5D/notes/SKILL.md', 'skill://me%40home/refunds/SKILL.md']);
        for (const uri of uris) expect(new URL(uri).href).toBe(uri);
        const refunds = snapshot.skills.get('skill://me%40home/refunds/SKILL.md')?.resources;
        const listed = refunds === undefined || refunds === 'dynamic' ? [] : refunds.map(resource => resource.uri);
        expect(listed).toContain(new URL('references/Q&A.md', 'skill://me%40home/refunds/SKILL.md').href);
    });

    it('encodes a prefix strictly, so acme:prod is not read as a host and port', async () => {
        const { options, warnings } = optionsWith({ prefix: ['acme:prod'] });
        const snapshot = await buildCatalogSnapshot(memorySkillFiles(fixtureFiles()), options);
        expect(warnings).toEqual([]);
        expect(snapshot.ordered).toHaveLength(3);
        expect(snapshot.ordered.every(skill => skill.uri.startsWith('skill://acme%3Aprod/') && new URL(skill.uri).href === skill.uri)).toBe(
            true
        );
    });

    it('skips invalid skills and warns about each one', async () => {
        const files = {
            ...fixtureFiles(),
            'bad/SKILL.md': INVALID,
            'broken/SKILL.md': `---
name: &a broken
description: d
---
`,
            'SKILL.md': `---
name: root
description: d
---
`,
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

    it('skips a skill whose SKILL.md is a symlink, or fails when strict', async () => {
        const files = withEntries(memorySkillFiles({ ...fixtureFiles(), 'linked/README.md': '# Linked\n' }), {
            linked: [{ name: 'SKILL.md', kind: 'unsupported' }]
        });
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(files, options);
        expect(snapshot.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        const expected = [{ path: 'linked/SKILL.md', message: expect.stringMatching(NOT_FOLLOWED) }];
        expect(warnings).toEqual(expected);
        expect(await strictProblems(files)).toEqual(expected);
    });

    it('reports a symlink outside any skill, such as a linked skill folder, or fails when strict', async () => {
        const files = withEntries(memorySkillFiles(fixtureFiles()), {
            '': [{ name: 'shared-skill', kind: 'unsupported' }],
            'acme/billing': [{ name: 'policy.md', kind: 'unsupported' }]
        });
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(files, options);
        expect(snapshot.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        const expected = ['acme/billing/policy.md', 'shared-skill'].map(path => ({ path, message: expect.stringMatching(NOT_FOLLOWED) }));
        expect(warnings.toSorted(byPath)).toEqual(expected);
        expect(await strictProblems(files)).toEqual(expected);
    });

    it('skips a skill with a name that cannot be represented in a URI, such as a lone surrogate', async () => {
        const memory = memorySkillFiles({
            ...fixtureFiles(),
            'bad/SKILL.md': `---
name: bad
description: d
---
`,
            'bad/x\uD800.md': 'x'
        });
        // An empty folder too: no file below it carries the name, yet the catalog lists the folder.
        const files = withEntries(memory, { 'git-workflow': [{ name: 'empty\uDC00', kind: 'directory' }], 'git-workflow/empty\uDC00': [] });
        const { options, warnings } = optionsWith();
        const snapshot = await buildCatalogSnapshot(files, options);
        expect(snapshot.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION]);
        const expected = ['bad/x\uD800.md', 'git-workflow/empty\uDC00'].map(path => ({
            path,
            message: expect.stringMatching(UNREPRESENTABLE)
        }));
        expect(warnings.toSorted(byPath)).toEqual(expected);
        expect(await strictProblems(files)).toEqual(expected);
    });

    it('collects every problem into one SkillCatalogError when strict', async () => {
        const files = {
            ...fixtureFiles(),
            'bad/SKILL.md': INVALID,
            'SKILL.md': `---
name: r
description: d
---
`
        };
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
        expect(lenient.warnings).toContainEqual({
            path: 'acme/billing/refunds',
            message: expect.stringMatching(/exceeds the limit.*Set strict: true to fail instead/)
        });
        expect(await strictProblems(memorySkillFiles(fixtureFiles()), { limits })).toContainEqual({
            path: 'acme/billing/refunds',
            message: expect.not.stringMatching(/strict/)
        });
    });

    it('reads each file once per build, however deeply skills nest', async () => {
        const memory = memorySkillFiles(fixtureFiles());
        const reads = new Map<string, number>();
        const files: SkillFiles = {
            list: dir => memory.list(dir),
            read: path => {
                reads.set(path, (reads.get(path) ?? 0) + 1);
                return memory.read(path);
            }
        };
        const snapshot = await buildCatalogSnapshot(files, optionsWith().options);
        expect([...reads.keys()].toSorted()).toEqual([...snapshot.files.values()].map(file => file.path).toSorted());
        expect(new Set(reads.values())).toEqual(new Set([1]));
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
    it('reads the record when first used and rejects unknown paths', async () => {
        const record: Record<string, string> = { 'a/SKILL.md': 'x' };
        const files = memorySkillFiles(record);
        record['a/extra.md'] = 'y';
        const entries = await files.list('a');
        expect(entries.map(entry => entry.name).toSorted()).toEqual(['SKILL.md', 'extra.md']);
        await expect(files.list('missing')).rejects.toThrow();
        await expect(files.read('a/missing.md')).rejects.toThrow();
    });

    it('re-reads the record when a walk starts, and serves changed content at once', async () => {
        const record: Record<string, string> = { 'a/SKILL.md': 'x' };
        const files = memorySkillFiles(record);
        expect(names(await files.list(''))).toEqual(['a']);
        record['a/b/c.md'] = 'c';
        delete record['a/SKILL.md'];
        expect(names(await files.list(''))).toEqual(['a']);
        expect(names(await files.list('a'))).toEqual(['b']);
        await expect(files.read('a/SKILL.md')).rejects.toThrow();
        record['a/b/c.md'] = 'changed';
        expect(text(await files.read('a/b/c.md'))).toBe('changed');
    });

    it('shows edits made between two catalog builds', async () => {
        const record = fixtureFiles();
        const files = memorySkillFiles(record);
        const before = await buildCatalogSnapshot(files, optionsWith().options);
        expect(before.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
        delete record['git-workflow/SKILL.md'];
        record['deploy/SKILL.md'] = `---
name: deploy
description: Deploy a release.
---
`;
        record['acme/billing/refunds/SKILL.md'] = `---
name: refunds
description: Refund workflow, revised.
---
`;
        const after = await buildCatalogSnapshot(files, optionsWith().options);
        expect(after.ordered.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, 'skill://deploy/SKILL.md']);
        expect(after.skills.get(REFUNDS)?.frontmatter.description).toBe('Refund workflow, revised.');
    });

    it('finds files stored under keys that are not normalised', async () => {
        const files = memorySkillFiles({ './a/SKILL.md': 'x', 'a//b/c.md': 'c' });
        expect(names(await files.list(''))).toEqual(['a']);
        expect(names(await files.list('a'))).toEqual(['SKILL.md', 'b']);
        expect(text(await files.read('a/b/c.md'))).toBe('c');
    });

    it('enumerates the record once per walk, however many directories and files the walk visits', async () => {
        let enumerations = 0;
        // A key that is not normalised is read through the index, not by re-reading the record.
        const target = { ...fixtureFiles(), './git-workflow/references/STYLE.md': '# Style\n' };
        const record = new Proxy(target, {
            ownKeys(object) {
                enumerations++;
                return Reflect.ownKeys(object);
            }
        });
        const files = memorySkillFiles(record);
        const snapshot = await buildCatalogSnapshot(files, optionsWith().options);
        expect(snapshot.files.has('skill://git-workflow/references/STYLE.md')).toBe(true);
        expect(snapshot.dirs.size).toBeGreaterThan(3);
        expect(enumerations).toBe(1);
        await buildCatalogSnapshot(files, optionsWith().options);
        expect(enumerations).toBe(2);
    });
});
