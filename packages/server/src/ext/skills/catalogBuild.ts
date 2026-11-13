import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { DIRECTORY_MIME_TYPE } from '@modelcontextprotocol/core/ext/skills';
import type { Resource } from '@modelcontextprotocol/core-internal';
import type { SkillFileInput } from '@modelcontextprotocol/core-internal/ext/skills';
import {
    buildSkillEntry,
    compareUris,
    isRoundTripUri,
    joinUri,
    mimeTypeFor,
    sha256Digest,
    validateSkillEntry
} from '@modelcontextprotocol/core-internal/ext/skills';

import { SkillCatalogError } from './errors';
import type { SkillFileEntry, SkillFiles, SkillWarning } from './types';

export interface CatalogFile {
    readonly path: string;
    readonly uri: string;
    readonly size: number;
    readonly digest: string;
    readonly mimeType: string;
}

type Hashed = Pick<CatalogFile, 'digest' | 'size'>;

// Everything a catalog serves, built once per load or reload: metadata only, never file contents.
export interface CatalogSnapshot {
    readonly ordered: readonly Skill[];
    readonly skills: ReadonlyMap<string, Skill>;
    readonly files: ReadonlyMap<string, CatalogFile>;
    readonly dirs: ReadonlyMap<string, readonly Resource[]>;
    readonly listed: readonly Resource[];
}

export interface CatalogBuildOptions {
    readonly prefix: readonly string[];
    readonly limits: { readonly files: number; readonly bytes: number };
    readonly strict: boolean;
    readonly warn: (warning: SkillWarning) => void;
}

interface TreeEntry {
    readonly path: string;
    readonly kind: SkillFileEntry['kind'];
}

interface BuiltSkill {
    readonly dir: string;
    readonly skill: Skill;
    readonly files: readonly CatalogFile[];
    readonly manifestSize: number;
    // Every entry below the skill's folder, nested skills' included, in tree order.
    readonly inside: readonly TreeEntry[];
}

type UriOf = (path: string) => string;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const dirname = (path: string): string => {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const NOT_FOLLOWED = 'symlinks and other special files are not followed; copy the file instead';

// Any non-directory named exactly `SKILL.md` marks a skill, so a symlinked one is reported rather than ignored.
const isManifest = (entry: TreeEntry): boolean => entry.kind !== 'directory' && basename(entry.path) === 'SKILL.md';

function append<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
    const list = lists.get(key);
    if (list === undefined) lists.set(key, [value]);
    else list.push(value);
}

// `undefined` when a name in `path` has no URI form (a lone surrogate, or no round trip).
function representableUri(uriOf: UriOf, path: string): string | undefined {
    let uri: string;
    try {
        uri = uriOf(path);
    } catch (error) {
        if (error instanceof URIError) return undefined;
        throw error;
    }
    return isRoundTripUri(uri) ? uri : undefined;
}

// Every non-hidden entry below the root, depth first; storage errors fail the build.
async function walk(files: SkillFiles): Promise<TreeEntry[]> {
    const tree: TreeEntry[] = [];
    const visit = async (dir: string): Promise<void> => {
        let entries: SkillFileEntry[];
        try {
            entries = await files.list(dir);
        } catch (error) {
            throw new SkillCatalogError([{ path: dir === '' ? '.' : dir, message: `cannot be listed: ${errorText(error)}` }]);
        }
        for (const entry of entries.toSorted((a, b) => compareUris(a.name, b.name))) {
            if (entry.name.startsWith('.')) continue;
            const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
            tree.push({ path, kind: entry.kind });
            if (entry.kind === 'directory') await visit(path);
        }
    };
    await visit('');
    return tree;
}

async function readFile(files: SkillFiles, path: string): Promise<Uint8Array> {
    try {
        return await files.read(path);
    } catch (error) {
        throw new SkillCatalogError([{ path, message: `cannot be read: ${errorText(error)}` }]);
    }
}

export async function buildCatalogSnapshot(files: SkillFiles, options: CatalogBuildOptions): Promise<CatalogSnapshot> {
    const tree = await walk(files);
    const problems: SkillWarning[] = [];
    const report = (warning: SkillWarning): void => {
        if (options.strict) problems.push(warning);
        else options.warn(warning);
    };
    const uriOf: UriOf = path => joinUri('skill://', [...options.prefix, ...path.split('/')]);

    for (const entry of tree) {
        const name = basename(entry.path);
        if (entry.kind === 'file' && name !== 'SKILL.md' && name.toLowerCase() === 'skill.md') {
            options.warn({ path: entry.path, message: 'did you mean SKILL.md? File names are case-sensitive' });
        }
    }

    // Collect each skill's entries, nested skills' included; a special file outside every skill is reported here.
    const skillDirs = new Set(tree.filter(entry => isManifest(entry)).map(entry => dirname(entry.path)));
    const insideOf = new Map<string, TreeEntry[]>();
    for (const entry of tree) {
        let inSkill = false;
        for (let dir = dirname(entry.path); dir !== ''; dir = dirname(dir)) {
            if (!skillDirs.has(dir)) continue;
            inSkill = true;
            append(insideOf, dir, entry);
        }
        if (!inSkill && entry.kind === 'unsupported' && !isManifest(entry)) {
            report({ path: entry.path, message: `${NOT_FOLLOWED} (skipped)` });
        }
    }

    const built: BuiltSkill[] = [];
    const hashed = new Map<string, Hashed>();
    // Deepest first, so each file is read and hashed once: by the innermost skill that holds it.
    const manifests = tree.filter(entry => isManifest(entry)).toSorted((a, b) => b.path.split('/').length - a.path.split('/').length);
    for (const entry of manifests) {
        const dir = dirname(entry.path);
        if (dir === '') {
            report({
                path: entry.path,
                message: 'a SKILL.md at the root has no skill path; point loadSkills (or your adapter) at its parent folder (skipped)'
            });
            continue;
        }
        const skill = await buildOne(files, insideOf.get(dir) ?? [], dir, uriOf, options, report, hashed);
        if (skill !== undefined) built.push(skill);
    }
    if (problems.length > 0) throw new SkillCatalogError(problems);
    if (built.length === 0) options.warn({ path: '.', message: 'no skills found (a skill is a folder containing SKILL.md)' });
    return assemble(built, tree, uriOf);
}

async function buildOne(
    files: SkillFiles,
    inside: readonly TreeEntry[],
    dir: string,
    uriOf: UriOf,
    options: CatalogBuildOptions,
    report: (warning: SkillWarning) => void,
    hashed: Map<string, Hashed>
): Promise<BuiltSkill | undefined> {
    const unsupported = inside.find(entry => entry.kind === 'unsupported');
    if (unsupported !== undefined) {
        report({ path: unsupported.path, message: `${NOT_FOLLOWED} (skill skipped)` });
        return undefined;
    }
    const manifestPath = `${dir}/SKILL.md`;
    const manifest: SkillFileInput[] = [];
    const catalogFiles: CatalogFile[] = [];
    for (const entry of inside) {
        // Folders too: an empty one's name appears only in its parent's directory listing.
        const uri = representableUri(uriOf, entry.path);
        if (uri === undefined) {
            report({ path: entry.path, message: 'this name cannot be represented in a URI (skill skipped)' });
            return undefined;
        }
        if (entry.kind !== 'file') continue;
        const own = entry.path === manifestPath;
        let file = own ? undefined : hashed.get(entry.path);
        if (file === undefined) {
            const bytes = await readFile(files, entry.path);
            if (own) manifest.push({ uri, bytes });
            file = { digest: await sha256Digest(bytes), size: bytes.byteLength };
            hashed.set(entry.path, file);
        }
        catalogFiles.push({ path: entry.path, uri, ...file, mimeType: mimeTypeFor(basename(entry.path)) });
    }
    // Parse SKILL.md on its own, then validate the entry that lists every file's digest.
    const parsed = await buildSkillEntry(uriOf(manifestPath), manifest);
    const resources = catalogFiles.map(({ uri, digest, size }) => ({ uri, digest, size })).toSorted((a, b) => compareUris(a.uri, b.uri));
    const skill = parsed.skill === undefined ? undefined : { ...parsed.skill, resources };
    const problems = skill === undefined ? parsed.problems : validateSkillEntry(skill);
    if (skill === undefined || problems.length > 0) {
        for (const message of problems) report({ path: manifestPath, message: `${message} (skill skipped)` });
        return undefined;
    }
    let totalBytes = 0;
    for (const file of catalogFiles) totalBytes += file.size;
    if (catalogFiles.length > options.limits.files || totalBytes > options.limits.bytes) {
        const remedy = options.strict ? 'Raise limits to allow it' : 'Set strict: true to fail instead, or raise limits';
        report({
            path: dir,
            message:
                `${catalogFiles.length} files / ${totalBytes} bytes exceeds the limit of ${options.limits.files} files / ` +
                `${options.limits.bytes} bytes; some hosts may decline it. ${remedy}`
        });
    }
    const manifestSize = catalogFiles.find(file => file.path === manifestPath)?.size ?? 0;
    return { dir, skill, files: catalogFiles, manifestSize, inside };
}

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

function assemble(built: readonly BuiltSkill[], tree: readonly TreeEntry[], uriOf: UriOf): CatalogSnapshot {
    // Frozen: entries are served unchecked and handed out by `entries`, so an edit must throw, not reach clients.
    const ordered = Object.freeze(built.map(item => deepFreeze(item.skill)).toSorted((a, b) => compareUris(a.uri, b.uri)));
    const files = new Map<string, CatalogFile>();
    const dirPaths = new Set<string>();
    for (const item of built) {
        for (const file of item.files) files.set(file.uri, file);
        dirPaths.add(item.dir);
        for (const entry of item.inside) {
            if (entry.kind === 'directory') dirPaths.add(entry.path);
        }
    }
    const childrenOf = new Map<string, TreeEntry[]>();
    for (const entry of tree) append(childrenOf, dirname(entry.path), entry);
    const dirs = new Map<string, Resource[]>();
    for (const dirPath of dirPaths) {
        const children: Resource[] = [];
        for (const entry of childrenOf.get(dirPath) ?? []) {
            if (entry.kind === 'directory') {
                children.push({ uri: uriOf(entry.path), name: basename(entry.path), mimeType: DIRECTORY_MIME_TYPE });
                continue;
            }
            const file = files.get(uriOf(entry.path));
            if (entry.kind === 'file' && file !== undefined) {
                children.push({ uri: file.uri, name: basename(entry.path), mimeType: file.mimeType, size: file.size });
            }
        }
        children.sort((a, b) => compareUris(a.uri, b.uri));
        dirs.set(uriOf(dirPath), children);
    }
    const listed = built
        .map(item => ({
            uri: item.skill.uri,
            name: item.skill.frontmatter.name,
            description: item.skill.frontmatter.description,
            mimeType: 'text/markdown',
            size: item.manifestSize
        }))
        .toSorted((a, b) => compareUris(a.uri, b.uri));
    return { ordered, skills: new Map(ordered.map(skill => [skill.uri, skill])), files, dirs, listed };
}
