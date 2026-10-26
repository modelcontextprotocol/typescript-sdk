// @modelcontextprotocol/server/ext/skills/node
//
// Node.js storage for the MCP Skills extension (SEP-2640): serve a folder of
// skills. The only module of the skills extension that imports Node built-ins.

import type { Dirent } from 'node:fs';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { SkillCatalog } from './extension';
import { SkillsExtension } from './extension';
import { fsPathWithin } from './fsPath';
import type { SkillCatalogOptions, SkillFileEntry, SkillFiles } from './types';

function kindOf(entry: Dirent): SkillFileEntry['kind'] {
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    return 'unsupported';
}

/**
 * A {@linkcode SkillFiles} adapter over a folder. `list` reports symlinks and
 * other special files as `unsupported`, so a catalog skips the skill that
 * contains one. `read` refuses anything that is not a regular file, and a
 * symlink as the final path component where the platform has `O_NOFOLLOW`;
 * symlinked folders earlier in a path passed to it directly are not checked.
 * Both throw a `TypeError` for a path that could leave `root` (a `..`
 * segment, also `..\` on Windows).
 */
export function nodeSkillFiles(root: string): SkillFiles {
    const base = path.resolve(root);
    const toFsPath = (relative: string): string => fsPathWithin(path, base, relative);
    return {
        async list(dir) {
            const entries = await readdir(toFsPath(dir), { withFileTypes: true });
            return entries.map(entry => ({ name: entry.name, kind: kindOf(entry) }));
        },
        async read(relative) {
            // O_NOFOLLOW (where the platform has it) refuses a final symlink even if one appeared after listing.
            const handle = await open(toFsPath(relative), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
                const stats = await handle.stat();
                if (!stats.isFile()) throw new Error(`${relative} is not a regular file`);
                const buffer = await handle.readFile();
                return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            } finally {
                await handle.close();
            }
        }
    };
}

/**
 * Loads every skill under `root` (a folder of skill folders, each with a
 * `SKILL.md`) into a {@linkcode SkillCatalog}. Same as
 * `SkillsExtension.load(nodeSkillFiles(root), options)`.
 *
 * @example
 * ```ts
 * const skills = await loadSkills('./skills');
 * skills.attach(mcp);
 * ```
 */
export function loadSkills(root: string, options?: SkillCatalogOptions): Promise<SkillCatalog> {
    return SkillsExtension.load(nodeSkillFiles(root), options);
}
