import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import type { CacheHint, Resource, ServerContext } from '@modelcontextprotocol/core-internal';

/** A problem found while building or serving skills. `path` names the file, folder or URI. */
export interface SkillWarning {
    path: string;
    message: string;
}

/** A skill file's content: text (sent as `text`) or bytes (sent as a base64 `blob`). */
export type SkillReadResult = { text: string; mimeType?: string } | { bytes: Uint8Array; mimeType?: string };

/** A catalog you build yourself: per-user, generated per request, too large to enumerate, or "dynamic". */
export interface SkillSource {
    /** One page of entries; an empty or partial listing is allowed. */
    list(params: { cursor?: string }, ctx: ServerContext): Promise<{ skills: Skill[]; nextCursor?: string }>;
    /** The entry whose `SKILL.md` is at `uri`, listed or not; `undefined` when none is served. */
    get(uri: string, ctx: ServerContext): Promise<Skill | undefined>;
    /** A skill file's content; `undefined` when no such file is served. */
    read(uri: string, ctx: ServerContext): Promise<SkillReadResult | undefined>;
    /** Direct children of a directory resource; `undefined` when `uri` is not one. Implementing it declares `directoryRead`. */
    readDirectory?(
        uri: string,
        params: { cursor?: string },
        ctx: ServerContext
    ): Promise<{ resources: Resource[]; nextCursor?: string } | undefined>;
    /** What appears in `resources/list` (a small set; not paged). Absent: nothing is listed. */
    listResources?(ctx: ServerContext): Promise<Resource[]>;
}

export interface SkillsOptions {
    /** `ttlMs` / `cacheScope` for skills/list, skills/get, directory reads and skill files (2026-07-28). Default `0` / `private`. */
    cacheHint?: CacheHint;
    /** Turn problems that are otherwise warnings into errors. Default `false`. */
    strict?: boolean;
    /** Where warnings go. Default: `console.warn` (stderr). */
    onWarning?: (warning: SkillWarning) => void;
}

export interface SkillSourceOptions extends SkillsOptions {
    source: SkillSource;
    /** Every URI the source serves starts with this. Default `skill://`. */
    baseUri?: string;
}
