import type { Skill, SkillResourceEntry } from '@modelcontextprotocol/core/ext/skills';
import { DIRECTORY_MIME_TYPE } from '@modelcontextprotocol/core/ext/skills';
import type { Resource } from '@modelcontextprotocol/core-internal';
import { buildSkillEntry, compareUris, isRoundTripUri, joinUri, mimeTypeFor } from '@modelcontextprotocol/core-internal/ext/skills';

import { SkillCatalogError } from './errors';
import type { SkillFileEntry, SkillFiles, SkillWarning } from './types';

/** One published file: where it is in storage and what the entry says about it. */
export interface CatalogFile {
    readonly path: string;
    readonly uri: string;
    readonly size: number;
    readonly digest: string;
    readonly mimeType: string;
}

/** Everything a catalog serves, built once per load or reload. Metadata only, never file contents. */
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
    /** Every entry below the skill's folder, nested skills' included, in tree order. */
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

/** Any non-directory named exactly `SKILL.md` marks a skill, so a symlinked one is reported rather than ignored. */
const isManifest = (entry: TreeEntry): boolean => entry.kind !== 'directory' && basename(entry.path) === 'SKILL.md';

/** Appends `value` to the list kept under `key`. */
function append<K, V>(lists: Map<K, V[]>, key: K, value: V): void {
    const list = lists.get(key);
    if (list === undefined) lists.set(key, [value]);
    else list.push(value);
}

/** The URI of `path`, or `undefined` when a name in it has no URI form (a lone surrogate, or no round trip). */
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

/** Every non-hidden entry below the root, depth first. Storage errors fail the build. */
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

/** Walks the storage, builds and checks every skill, and assembles what the catalog serves. */
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

    // One pass over each entry's folders collects every skill's entries (nested skills' included), in tree order.
    // A special file inside a skill is reported when that skill is built; one outside every skill (a symlinked
    // skill folder, say) is reported here. A root SKILL.md is reported in the loop below.
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
    for (const entry of tree) {
        if (!isManifest(entry)) continue;
        const dir = dirname(entry.path);
        if (dir === '') {
            report({
                path: entry.path,
                message: 'a SKILL.md at the root has no skill path; point loadSkills (or your adapter) at its parent folder (skipped)'
            });
            continue;
        }
        const skill = await buildOne(files, insideOf.get(dir) ?? [], dir, uriOf, options, report);
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
    report: (warning: SkillWarning) => void
): Promise<BuiltSkill | undefined> {
    const unsupported = inside.find(entry => entry.kind === 'unsupported');
    if (unsupported !== undefined) {
        report({ path: unsupported.path, message: `${NOT_FOLLOWED} (skill skipped)` });
        return undefined;
    }
    const inputs: Array<{ path: string; uri: string; bytes: Uint8Array }> = [];
    for (const entry of inside) {
        // Folders too: an empty one's name appears only in its parent's directory listing.
        const uri = representableUri(uriOf, entry.path);
        if (uri === undefined) {
            report({ path: entry.path, message: 'this name cannot be represented in a URI (skill skipped)' });
            return undefined;
        }
        if (entry.kind === 'file') inputs.push({ path: entry.path, uri, bytes: await readFile(files, entry.path) });
    }
    const manifestUri = uriOf(`${dir}/SKILL.md`);
    const { skill, problems } = await buildSkillEntry(manifestUri, inputs);
    if (skill === undefined || problems.length > 0) {
        for (const message of problems) report({ path: `${dir}/SKILL.md`, message: `${message} (skill skipped)` });
        return undefined;
    }
    let totalBytes = 0;
    for (const input of inputs) totalBytes += input.bytes.byteLength;
    if (inputs.length > options.limits.files || totalBytes > options.limits.bytes) {
        report({
            path: dir,
            message:
                `${inputs.length} files / ${totalBytes} bytes exceeds the limit of ${options.limits.files} files / ` +
                `${options.limits.bytes} bytes; some hosts may decline it. Set strict: true to fail instead, or raise limits`
        });
    }
    const digests = new Map((skill.resources as SkillResourceEntry[]).map(resource => [resource.uri, resource.digest]));
    const catalogFiles = inputs.map(input => ({
        path: input.path,
        uri: input.uri,
        size: input.bytes.byteLength,
        digest: digests.get(input.uri)!,
        mimeType: mimeTypeFor(basename(input.path))
    }));
    const manifestSize = inputs.find(input => input.uri === manifestUri)?.bytes.byteLength ?? 0;
    return { dir, skill, files: catalogFiles, manifestSize, inside };
}

/** Freezes `value` and every object and array inside it. */
function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

function assemble(built: readonly BuiltSkill[], tree: readonly TreeEntry[], uriOf: UriOf): CatalogSnapshot {
    // Entries are served as they are (trusted, never re-validated) and handed to callers by `entries`: frozen, so an
    // edit (say, of a description for display) throws instead of changing what clients receive.
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
