import { describe, expect, it } from 'vitest';

import { memorySkillFiles } from '../../../src/ext/skills/index';

const RECORD = {
    'SKILL.md': '# skill',
    'sub/other.txt': 'other'
};

describe('memorySkillFiles', () => {
    it('lists a directory given with a trailing slash or a leading dot segment', async () => {
        const files = memorySkillFiles(RECORD);

        await expect(files.list('sub/')).resolves.toEqual([{ name: 'other.txt', kind: 'file' }]);
        await expect(files.list('./sub')).resolves.toEqual([{ name: 'other.txt', kind: 'file' }]);
    });

    it('lists the root for an empty directory', async () => {
        const files = memorySkillFiles(RECORD);

        await expect(files.list('')).resolves.toEqual(
            expect.arrayContaining([
                { name: 'SKILL.md', kind: 'file' },
                { name: 'sub', kind: 'directory' }
            ])
        );
    });

    it('reads a file given in a non-canonical form', async () => {
        const files = memorySkillFiles(RECORD);

        await expect(files.read('./SKILL.md')).resolves.toEqual(expect.any(Uint8Array));
        await expect(files.read('sub//other.txt')).resolves.toEqual(expect.any(Uint8Array));
    });

    it('finds a record key that is itself non-canonical', async () => {
        const files = memorySkillFiles({ './SKILL.md': '# skill' });

        await expect(files.read('SKILL.md')).resolves.toEqual(expect.any(Uint8Array));
    });

    it('rejects a path that could leave the record', async () => {
        const files = memorySkillFiles(RECORD);

        await expect(files.list('..')).rejects.toThrow(TypeError);
        await expect(files.read('../SKILL.md')).rejects.toThrow(TypeError);
        await expect(files.read('')).rejects.toThrow(TypeError);
    });

    it('still reports a missing path', async () => {
        const files = memorySkillFiles(RECORD);

        await expect(files.list('missing')).rejects.toThrow('no such directory: missing');
        await expect(files.read('missing.txt')).rejects.toThrow('no such file: missing.txt');
    });
});
