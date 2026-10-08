/**
 * `SkillsExtension` — the server side of the MCP Skills extension
 * (`io.modelcontextprotocol/skills`, SEP-2640) as a {@linkcode ServerExtension}.
 * It owns the wire: the capability, `skills/list`, `skills/get`, and
 * `resources/directory/read` when the source can read directories. The
 * skills themselves come from the {@link SkillSource} the server passes in;
 * their files are ordinary resources, registered and read the usual way.
 *
 * ```ts
 * const skills = new SkillsExtension({
 *     list: () => ({ skills: [entry] }),
 *     get: ({ uri }) => (uri === entry.uri ? entry : undefined)
 * });
 * const server = new McpServer(info, { extensions: [skills] });
 * server.registerResource('git-workflow', entry.uri, { mimeType: 'text/markdown' }, uri => ({
 *     contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skillMd }]
 * }));
 * ```
 */

import type { Resource, ServerContext } from '@modelcontextprotocol/core-internal';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import type {
    GetSkillParams,
    GetSkillResult,
    ListSkillsParams,
    ListSkillsResult,
    ReadResourceDirectoryParams,
    ReadResourceDirectoryResult,
    Skill,
    SkillsCacheScope
} from '@modelcontextprotocol/core-internal/ext/skills';
import {
    getSkillParamsSchema,
    listSkillsParamsSchema,
    readResourceDirectoryParamsSchema,
    readResourceDirectoryResultSchema,
    SKILLS_EXTENSION_ID,
    skillSchema
} from '@modelcontextprotocol/core-internal/ext/skills';

import type { ServerExtension } from '../../server/extension';
import type { Server } from '../../server/server';

/**
 * Where a server's skills come from. Each method receives the request's
 * params and context; pagination and any per-caller view are the source's.
 */
export interface SkillSource {
    /** A page of skill entries. An empty or partial listing is allowed. */
    list(
        params: ListSkillsParams,
        ctx: ServerContext
    ): { skills: Skill[]; nextCursor?: string } | Promise<{ skills: Skill[]; nextCursor?: string }>;
    /** The entry for the skill whose `SKILL.md` is at `params.uri`, listed or not; `undefined` when none is served. */
    get(params: GetSkillParams, ctx: ServerContext): Skill | undefined | Promise<Skill | undefined>;
    /** The direct children of a directory resource; `undefined` when `params.uri` is not one. Implementing it advertises `directoryRead`. */
    readDirectory?(
        params: ReadResourceDirectoryParams,
        ctx: ServerContext
    ): ReadResourceDirectoryPage | undefined | Promise<ReadResourceDirectoryPage | undefined>;
}

/** A page of `resources/directory/read` children. */
export interface ReadResourceDirectoryPage {
    resources: Resource[];
    nextCursor?: string;
}

/** Options for {@link SkillsExtension}. */
export interface SkillsExtensionOptions {
    /** `ttlMs` and `cacheScope` for `skills/list` and `skills/get` results. Default `{ ttlMs: 0, cacheScope: 'private' }`. */
    cacheHint?: { ttlMs?: number; cacheScope?: SkillsCacheScope };
}

const invalidEntry = (error: unknown): never => {
    throw new ProtocolError(ProtocolErrorCode.InternalError, `Skill source returned an invalid entry: ${String(error)}`);
};

const validEntry = (skill: Skill): Skill => {
    const parsed = skillSchema.safeParse(skill);
    return parsed.success ? (parsed.data as Skill) : invalidEntry(parsed.error);
};

export class SkillsExtension implements ServerExtension {
    readonly id = SKILLS_EXTENSION_ID;
    readonly source: SkillSource;
    readonly #cache: { ttlMs: number; cacheScope: SkillsCacheScope };

    constructor(source: SkillSource, options?: SkillsExtensionOptions) {
        this.source = source;
        this.#cache = { ttlMs: options?.cacheHint?.ttlMs ?? 0, cacheScope: options?.cacheHint?.cacheScope ?? 'private' };
    }

    install(server: Server): void {
        const directoryRead = this.source.readDirectory !== undefined;
        // Skill files are resources, so the extension requires the resources capability.
        server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: directoryRead ? { directoryRead } : {} } });

        server.setRequestHandler('skills/list', { params: listSkillsParamsSchema }, async (params, ctx): Promise<ListSkillsResult> => {
            const page = await this.source.list(params, ctx);
            return {
                skills: page.skills.map(skill => validEntry(skill)),
                ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
                ...this.#cache
            };
        });

        server.setRequestHandler('skills/get', { params: getSkillParamsSchema }, async (params, ctx): Promise<GetSkillResult> => {
            const skill = await this.source.get(params, ctx);
            if (skill === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${params.uri}`);
            return { skill: validEntry(skill), ...this.#cache };
        });

        const readDirectory = this.source.readDirectory?.bind(this.source);
        if (readDirectory === undefined) return;
        server.setRequestHandler(
            'resources/directory/read',
            { params: readResourceDirectoryParamsSchema },
            async (params, ctx): Promise<ReadResourceDirectoryResult> => {
                const page = await readDirectory(params, ctx);
                if (page === undefined) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${params.uri} is not a directory resource`);
                }
                const parsed = readResourceDirectoryResultSchema.safeParse(page);
                return parsed.success ? (parsed.data as ReadResourceDirectoryResult) : invalidEntry(parsed.error);
            }
        );
    }
}
