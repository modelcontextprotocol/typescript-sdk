import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fsPathWithin } from '../../../src/ext/skills/fsPath';
import type { SkillWarning } from '../../../src/ext/skills/index';
import { memorySkillFiles, SkillCatalogError, SkillsExtension } from '../../../src/ext/skills/index';
import { loadSkills, nodeSkillFiles } from '../../../src/ext/skills/node';
import { ESCALATION, fixtureFiles, GIT, PNG, REFUNDS } from './fixtures';
import { errorOf, newServer, resultOf } from './harness';

let root: string;

async function writeTree(files: Record<string, string | Uint8Array>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
    }
}

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mcp-skills-'));
    await writeTree(fixtureFiles());
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('nodeSkillFiles', () => {
    it('lists files and folders and reads exact bytes', async () => {
        const files = nodeSkillFiles(root);
        const entries = await files.list('acme/billing/refunds');
        expect(entries.map(entry => [entry.name, entry.kind]).toSorted()).toEqual([
            ['SKILL.md', 'file'],
            ['assets', 'directory'],
            ['escalation', 'directory'],
            ['templates', 'directory']
        ]);
        expect(await files.read('acme/billing/refunds/assets/logo.png')).toEqual(PNG);
    });

    it.skipIf(process.platform === 'win32')('reports symlinks as unsupported and never reads through them', async () => {
        await symlink(path.join(root, 'git-workflow', 'references', 'REVIEW.md'), path.join(root, 'git-workflow', 'linked.md'));
        const files = nodeSkillFiles(root);
        expect(await files.list('git-workflow')).toContainEqual({ name: 'linked.md', kind: 'unsupported' });
        await expect(files.read('git-workflow/linked.md')).rejects.toThrow();
    });

    it('rejects paths that leave the root', async () => {
        await expect(nodeSkillFiles(root).read('../outside.md')).rejects.toThrow(TypeError);
        await expect(nodeSkillFiles(root).list('acme/../..')).rejects.toThrow(TypeError);
    });
});

// The containment rule nodeSkillFiles applies, run with each platform's path rules so every OS tests both.
describe('fsPathWithin', () => {
    it('rejects a Windows ..\\ escape by Windows rules', () => {
        const base = String.raw`C:\skills`;
        // What the adapter used to do: `path.join` resolves the backslash `..` and leaves the root.
        expect(path.win32.join(base, String.raw`..\secret`)).toBe(String.raw`C:\secret`);
        for (const escape of [String.raw`..\secret`, String.raw`git-workflow\..\..\secret`, String.raw`git-workflow/..\..\secret`]) {
            expect(() => fsPathWithin(path.win32, base, escape)).toThrow(TypeError);
        }
        expect(() => fsPathWithin(path.win32, base, String.raw`git-workflow\..\SKILL.md`)).toThrow(TypeError);
        expect(() => fsPathWithin(path.win32, base, '../secret')).toThrow(TypeError);
    });

    it('keeps paths inside the root by Windows rules', () => {
        const base = String.raw`C:\skills`;
        expect(fsPathWithin(path.win32, base, '')).toBe(base);
        expect(fsPathWithin(path.win32, base, 'git-workflow/references/REVIEW.md')).toBe(
            String.raw`C:\skills\git-workflow\references\REVIEW.md`
        );
        expect(fsPathWithin(path.win32, base, '..notes/a.md')).toBe(String.raw`C:\skills\..notes\a.md`);
    });

    it('treats a backslash as part of a name by POSIX rules', () => {
        expect(fsPathWithin(path.posix, '/skills', String.raw`..\secret`)).toBe(String.raw`/skills/..\secret`);
        expect(fsPathWithin(path.posix, '/skills', 'git-workflow/SKILL.md')).toBe('/skills/git-workflow/SKILL.md');
        expect(() => fsPathWithin(path.posix, '/skills', '../secret')).toThrow(TypeError);
        expect(() => fsPathWithin(path.posix, '/skills', 'a/../../secret')).toThrow(TypeError);
    });
});

describe('loadSkills', () => {
    it('builds the same entries as the in-memory adapter', async () => {
        const fromDisk = await loadSkills(root);
        const inMemory = await SkillsExtension.load(memorySkillFiles(fixtureFiles()));
        expect(fromDisk.entries).toEqual(inMemory.entries);
        expect(fromDisk.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
    });

    it.skipIf(process.platform === 'win32')('skips a skill that contains a symlink, with a warning', async () => {
        await symlink(path.join(root, 'git-workflow', 'references', 'REVIEW.md'), path.join(root, 'git-workflow', 'linked.md'));
        const warnings: SkillWarning[] = [];
        const catalog = await loadSkills(root, { onWarning: warning => warnings.push(warning) });
        expect(catalog.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION]);
        expect(warnings).toContainEqual({ path: 'git-workflow/linked.md', message: expect.stringMatching(/symlinks/) });
    });

    it.skipIf(process.platform === 'win32')('skips a symlinked skill folder at the root, with a warning, and loads the rest', async () => {
        const outside = await mkdtemp(path.join(tmpdir(), 'mcp-skills-linked-'));
        try {
            await writeFile(
                path.join(outside, 'SKILL.md'),
                `---
name: linked-skill
description: Lives outside the root.
---
# Linked
`
            );
            await symlink(outside, path.join(root, 'linked-skill'), 'dir');
            const warnings: SkillWarning[] = [];
            const catalog = await loadSkills(root, { onWarning: warning => warnings.push(warning) });
            expect(catalog.entries.map(skill => skill.uri)).toEqual([REFUNDS, ESCALATION, GIT]);
            expect(warnings).toContainEqual({ path: 'linked-skill', message: expect.stringMatching(/symlinks.*\(skipped\)/) });
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('fails with SkillCatalogError when the folder does not exist', async () => {
        await expect(loadSkills(path.join(root, 'missing'))).rejects.toBeInstanceOf(SkillCatalogError);
    });

    it('refuses a file edited on disk until reload() publishes it', async () => {
        const catalog = await loadSkills(root, { onWarning: () => undefined });
        const mcp = newServer();
        catalog.attach(mcp);
        await writeFile(path.join(root, 'git-workflow', 'references', 'REVIEW.md'), '# Review v2\n');
        const uri = 'skill://git-workflow/references/REVIEW.md';
        expect(await errorOf(mcp, 'resources/read', { uri })).toMatchObject({ code: -32_603 });
        expect(await catalog.reload()).toEqual({ added: [], removed: [], changed: [GIT], listChanged: false });
        expect(await resultOf(mcp, 'resources/read', { uri })).toMatchObject({ contents: [{ uri, text: '# Review v2\n' }] });
    });
});
