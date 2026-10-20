import { encodeUtf8 } from '@modelcontextprotocol/core-internal/ext/skills';

import type { SkillFileEntry, SkillFiles } from './types';

// Splits a relative `/`-separated path, rejecting `..` and empty paths.
export function splitRelativePath(path: string, label: string): string[] {
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        throw new TypeError(`${label} must be a relative path without ".." (got ${JSON.stringify(path)})`);
    }
    return segments;
}

// A memory record's directories and files, by normalised path.
interface MemoryIndex {
    // Children of every directory (`''` is the root), in record order.
    readonly dirs: ReadonlyMap<string, ReadonlyMap<string, SkillFileEntry>>;
    // The record key that holds each file.
    readonly files: ReadonlyMap<string, string>;
}

function indexRecord(keys: readonly string[]): MemoryIndex {
    const dirs = new Map<string, Map<string, SkillFileEntry>>();
    const files = new Map<string, string>();
    for (const key of keys) {
        const segments = splitRelativePath(key, 'file path');
        let dir = '';
        for (const [depth, name] of segments.entries()) {
            let children = dirs.get(dir);
            if (children === undefined) {
                children = new Map();
                dirs.set(dir, children);
            }
            children.set(name, { name, kind: depth < segments.length - 1 ? 'directory' : 'file' });
            dir = dir === '' ? name : `${dir}/${name}`;
        }
        files.set(dir, key);
    }
    return { dirs, files };
}

/**
 * An in-memory adapter. The record is re-read whenever a walk starts — `list('')` — so `reload()` sees later changes.
 * Other calls use the index from that read (built on first use if no walk has started), so their cost does not grow
 * with the record. File contents are always read live.
 */
export function memorySkillFiles(files: Record<string, string | Uint8Array>): SkillFiles {
    let index: MemoryIndex | undefined;
    const reindex = (): MemoryIndex => {
        index = indexRecord(Object.keys(files));
        return index;
    };
    return {
        async list(dir) {
            const children = (dir === '' ? reindex() : (index ?? reindex())).dirs.get(dir);
            if (children !== undefined) return Array.from(children.values(), entry => ({ ...entry }));
            if (dir === '') return [];
            throw new Error(`no such directory: ${dir}`);
        },
        async read(path) {
            // Keys written as `./a/b` or `a//b` are found through the index.
            const key = Object.hasOwn(files, path) ? path : (index ?? reindex()).files.get(path);
            const content = key === undefined ? undefined : files[key];
            if (content === undefined) throw new Error(`no such file: ${path}`);
            return typeof content === 'string' ? encodeUtf8(content) : content;
        }
    };
}
