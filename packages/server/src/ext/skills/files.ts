import { encodeUtf8 } from '@modelcontextprotocol/core-internal';

import type { SkillFileEntry, SkillFiles } from './types';

/** Splits a relative `/`-separated path, rejecting `..` and empty paths. */
export function splitRelativePath(path: string, label: string): string[] {
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        throw new TypeError(`${label} must be a relative path without ".." (got ${JSON.stringify(path)})`);
    }
    return segments;
}

/** An in-memory adapter. The record is read on every call, so `reload()` sees later changes to it. */
export function memorySkillFiles(files: Record<string, string | Uint8Array>): SkillFiles {
    const current = (): Map<string, string | Uint8Array> => {
        const entries = new Map<string, string | Uint8Array>();
        for (const [path, content] of Object.entries(files)) entries.set(splitRelativePath(path, 'file path').join('/'), content);
        return entries;
    };
    return {
        async list(dir) {
            const prefix = dir === '' ? '' : `${dir}/`;
            const children = new Map<string, SkillFileEntry>();
            for (const path of current().keys()) {
                if (!path.startsWith(prefix)) continue;
                const [name, ...deeper] = path.slice(prefix.length).split('/');
                if (name !== undefined) children.set(name, { name, kind: deeper.length > 0 ? 'directory' : 'file' });
            }
            if (dir !== '' && children.size === 0) throw new Error(`no such directory: ${dir}`);
            return [...children.values()];
        },
        async read(path) {
            const content = current().get(path);
            if (content === undefined) throw new Error(`no such file: ${path}`);
            return typeof content === 'string' ? encodeUtf8(content) : content;
        }
    };
}
