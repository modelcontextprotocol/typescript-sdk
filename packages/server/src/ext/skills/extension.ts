import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import {
    GetSkillRequestParamsSchema,
    ListSkillsRequestParamsSchema,
    ReadResourceDirectoryRequestParamsSchema,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from '@modelcontextprotocol/core/ext/skills';
import type { CacheHint, ListResourcesResult, ReadResourceResult, ServerContext } from '@modelcontextprotocol/core-internal';
import {
    assertValidCacheHint,
    canonicalUri,
    encodeBase64,
    isModernProtocolVersion,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    skillEntryProblems
} from '@modelcontextprotocol/core-internal';

import type { McpServer } from '../../server/mcp';
import { ResourceTemplate } from '../../server/mcp';
import type { Server } from '../../server/server';
import { defaultWarn } from './errors';
import { trustedSources } from './internal';
import type { SkillReadResult, SkillSource, SkillSourceOptions, SkillWarning } from './types';

const SCHEME_URI = /^[a-z][\d+.a-z-]*:\/\//i;

function describeEntry(value: unknown): string {
    const uri = (value as { uri?: unknown } | null)?.uri;
    return typeof uri === 'string' ? uri : '(entry without a uri)';
}

function toContents(uri: string, result: SkillReadResult): ReadResourceResult['contents'][number] {
    const mimeType = result.mimeType === undefined ? {} : { mimeType: result.mimeType };
    return 'text' in result ? { uri, ...mimeType, text: result.text } : { uri, ...mimeType, blob: encodeBase64(result.bytes) };
}

/**
 * The MCP Skills extension (SEP-2640) for one catalog of skills. One instance
 * serves any number of servers: call {@linkcode SkillsExtension.attach} on each
 * (before connecting). Build it from a {@linkcode SkillSource}, or with
 * `SkillsExtension.load(files)` from storage.
 */
export class SkillsExtension {
    readonly id = SKILLS_EXTENSION_ID;
    readonly #source: SkillSource;
    readonly #trusted: boolean;
    readonly #baseRoot: string;
    readonly #cacheHint: CacheHint | undefined;
    readonly #cache: { ttlMs: number; cacheScope: 'public' | 'private' };
    readonly #strict: boolean;
    readonly #warn: (warning: SkillWarning) => void;
    readonly #attached = new WeakSet<McpServer>();

    constructor(options: SkillSourceOptions) {
        if (options.cacheHint !== undefined) assertValidCacheHint(options.cacheHint, 'skills cacheHint');
        const baseUri = options.baseUri ?? 'skill://';
        if (!SCHEME_URI.test(baseUri)) throw new TypeError(`baseUri must look like "scheme://…" (got ${JSON.stringify(baseUri)})`);
        this.#baseRoot = baseUri.endsWith('://') ? baseUri : `${baseUri.replace(/\/+$/, '')}/`;
        this.#source = options.source;
        this.#trusted = trustedSources.has(options.source);
        this.#cacheHint = options.cacheHint;
        this.#cache = { ttlMs: options.cacheHint?.ttlMs ?? 0, cacheScope: options.cacheHint?.cacheScope ?? 'private' };
        this.#strict = options.strict ?? false;
        this.#warn = options.onWarning ?? defaultWarn;
    }

    /**
     * Serves these skills on `mcp`: declares the capability, registers the
     * skill resource template and the skills methods. Must run before
     * connecting. Calling it again for the same server does nothing.
     */
    attach(mcp: McpServer): void {
        if (this.#attached.has(mcp)) return;
        if (mcp.isConnected()) throw new Error('attach skills before connecting the server');
        const server = mcp.server;
        const directoryRead = this.#source.readDirectory !== undefined;
        server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: directoryRead ? { directoryRead: true } : {} } });
        const list = this.#source.listResources === undefined ? undefined : (ctx: ServerContext) => this.#listResources(ctx);
        mcp.registerResource(
            SKILLS_EXTENSION_ID,
            new ResourceTemplate(`${this.#baseRoot}{+path}`, { list }),
            this.#cacheHint === undefined ? {} : { cacheHint: this.#cacheHint },
            (uri, _variables, ctx) => this.#read(uri, ctx)
        );
        server.setRequestHandler(SKILLS_LIST_METHOD, { params: ListSkillsRequestParamsSchema }, (params, ctx) =>
            this.#list(server, params.cursor, ctx)
        );
        server.setRequestHandler(SKILLS_GET_METHOD, { params: GetSkillRequestParamsSchema }, (params, ctx) =>
            this.#get(server, params.uri, ctx)
        );
        if (directoryRead) {
            server.setRequestHandler(RESOURCES_DIRECTORY_READ_METHOD, { params: ReadResourceDirectoryRequestParamsSchema }, (params, ctx) =>
                this.#readDirectory(server, params.uri, params.cursor, ctx)
            );
        }
        this.#attached.add(mcp);
        this.afterAttach(mcp);
    }

    /** Called once per server after {@linkcode SkillsExtension.attach} registered everything. */
    protected afterAttach(_mcp: McpServer): void {}

    #cacheFields(server: Server): { ttlMs?: number; cacheScope?: 'public' | 'private' } {
        return isModernProtocolVersion(server.getNegotiatedProtocolVersion() ?? '') ? { ...this.#cache } : {};
    }

    #keepValid(skills: readonly Skill[]): Skill[] {
        if (this.#trusted) return [...skills];
        const kept: Skill[] = [];
        for (const candidate of skills) {
            const problems = skillEntryProblems(candidate);
            if (problems.length === 0) {
                kept.push(candidate);
                continue;
            }
            const message = `invalid skill entry from the source: ${problems.join('; ')}`;
            if (this.#strict) throw new ProtocolError(ProtocolErrorCode.InternalError, `${describeEntry(candidate)}: ${message}`);
            this.#warn({ path: describeEntry(candidate), message: `${message} (dropped from skills/list)` });
        }
        return kept;
    }

    async #list(server: Server, cursor: string | undefined, ctx: ServerContext) {
        const page = await this.#source.list(cursor === undefined ? {} : { cursor }, ctx);
        return {
            skills: this.#keepValid(page.skills),
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            ...this.#cacheFields(server)
        };
    }

    async #get(server: Server, uri: string, ctx: ServerContext) {
        const skill = await this.#source.get(uri, ctx);
        if (skill === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`);
        if (!this.#trusted) {
            const problems = skillEntryProblems(skill);
            if (problems.length > 0) {
                const message = `invalid skill entry from the source: ${problems.join('; ')}`;
                this.#warn({ path: uri, message });
                throw new ProtocolError(ProtocolErrorCode.InternalError, message);
            }
        }
        if (canonicalUri(skill.uri) !== canonicalUri(uri)) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, `the skill source returned ${skill.uri} for ${uri}`);
        }
        return { skill, ...this.#cacheFields(server) };
    }

    async #read(uri: URL, ctx: ServerContext): Promise<ReadResourceResult> {
        const result = await this.#source.read(uri.href, ctx);
        if (result === undefined) throw new ResourceNotFoundError(uri.href);
        return { contents: [toContents(uri.href, result)] };
    }

    async #readDirectory(server: Server, uri: string, cursor: string | undefined, ctx: ServerContext) {
        const page = await this.#source.readDirectory!(uri, cursor === undefined ? {} : { cursor }, ctx);
        if (page === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${uri} is not a directory resource`);
        return {
            resources: page.resources,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
            ...this.#cacheFields(server)
        };
    }

    async #listResources(ctx: ServerContext): Promise<ListResourcesResult> {
        const resources = await this.#source.listResources!(ctx);
        const kept = [];
        for (const resource of resources) {
            if (canonicalUri(resource.uri)?.startsWith(this.#baseRoot)) kept.push(resource);
            else
                this.#warn({
                    path: resource.uri,
                    message: `listResources returned a URI outside ${this.#baseRoot}; dropped from resources/list`
                });
        }
        return { resources: kept };
    }
}
