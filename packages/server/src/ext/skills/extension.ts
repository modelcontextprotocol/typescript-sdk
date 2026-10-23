import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import {
    GetSkillRequestParamsSchema,
    ListSkillsRequestParamsSchema,
    ReadResourceDirectoryRequestParamsSchema,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILL_LIMITS,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from '@modelcontextprotocol/core/ext/skills';
import type { CacheHint, ListResourcesResult, ReadResourceResult, ServerContext } from '@modelcontextprotocol/core-internal';
import {
    assertValidCacheHint,
    isModernProtocolVersion,
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError
} from '@modelcontextprotocol/core-internal';
import {
    canonicalUri,
    encodeBase64,
    joinUri,
    skillEntryProblems,
    trimTrailingSlashes
} from '@modelcontextprotocol/core-internal/ext/skills';

import type { McpServer } from '../../server/mcp';
import { ResourceTemplate } from '../../server/mcp';
import type { Server } from '../../server/server';
import type { CatalogBuildOptions, CatalogSnapshot } from './catalogBuild';
import { buildCatalogSnapshot } from './catalogBuild';
import type { CatalogState } from './catalogSource';
import { catalogSource } from './catalogSource';
import { defaultWarn } from './errors';
import { splitRelativePath } from './files';
import { trustedSources } from './internal';
import { resolvePageSize } from './paging';
import type {
    SkillCatalogChanges,
    SkillCatalogOptions,
    SkillFiles,
    SkillReadResult,
    SkillSource,
    SkillSourceOptions,
    SkillWarning
} from './types';

const SCHEME_URI = /^[a-z][\d+.a-z-]*:\/\//i;

function describeEntry(value: unknown): string {
    const uri = (value as { uri?: unknown } | null)?.uri;
    return typeof uri === 'string' ? uri : '(entry without a uri)';
}

function toContents(uri: string, result: SkillReadResult): ReadResourceResult['contents'][number] {
    const mimeType = result.mimeType === undefined ? {} : { mimeType: result.mimeType };
    return 'text' in result ? { uri, ...mimeType, text: result.text } : { uri, ...mimeType, blob: encodeBase64(result.bytes) };
}

// Servers with a skills extension attached: one per server, as SEP-3371 rejects a duplicate extension identifier.
const skillsServers = new WeakSet<McpServer>();

// Runs after a successful `attach`, by extension (`SkillCatalog` tracks servers); off the class so no subclass hooks it.
const afterAttach = new WeakMap<SkillsExtension, (mcp: McpServer) => void>();

const ONE_PER_SERVER =
    'another skills extension is already attached to this server; attach one per server ' +
    '(to serve several folders or sources, combine them behind one SkillFiles adapter or SkillSource)';

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

    /**
     * Builds a catalog from storage through a {@linkcode SkillFiles} adapter
     * (`memorySkillFiles`, `nodeSkillFiles`, or your own).
     */
    static load(files: SkillFiles, options?: SkillCatalogOptions): Promise<SkillCatalog> {
        return SkillCatalog.load(files, options);
    }

    constructor(options: SkillSourceOptions) {
        if (options.cacheHint !== undefined) assertValidCacheHint(options.cacheHint, 'skills cacheHint');
        const baseUri = options.baseUri ?? 'skill://';
        // Canonical, like the request URIs that the template and the listResources filter are matched against.
        const canonical = SCHEME_URI.test(baseUri) ? canonicalUri(baseUri) : undefined;
        if (canonical === undefined) throw new TypeError(`baseUri must be a "scheme://…" URI (got ${JSON.stringify(baseUri)})`);
        this.#baseRoot = canonical.endsWith('://') ? canonical : `${trimTrailingSlashes(canonical)}/`;
        this.#source = options.source;
        this.#trusted = trustedSources.has(options.source);
        this.#cacheHint = options.cacheHint;
        this.#cache = { ttlMs: options.cacheHint?.ttlMs ?? 0, cacheScope: options.cacheHint?.cacheScope ?? 'private' };
        this.#strict = options.strict ?? false;
        this.#warn = options.onWarning ?? defaultWarn;
    }

    /**
     * Serves these skills on `mcp`: registers the skill resource template and
     * the skills methods, then declares the capability. Must run before
     * connecting. Calling it again for the same server does nothing. One
     * skills extension per server: attaching another one throws and leaves the
     * server as it was, as does attaching to a server that already handles one
     * of the skills methods.
     *
     * @experimental How an extension is wired to a server may change in a minor release.
     */
    attach(mcp: McpServer): void {
        if (this.#attached.has(mcp)) return;
        if (mcp.isConnected()) throw new Error('attach skills before connecting the server');
        if (skillsServers.has(mcp)) throw new Error(ONE_PER_SERVER);
        const server = mcp.server;
        const directoryRead = this.#source.readDirectory !== undefined;
        const list = this.#source.listResources === undefined ? undefined : (ctx: ServerContext) => this.#listResources(ctx);
        server.assertCanSetRequestHandler(SKILLS_LIST_METHOD);
        server.assertCanSetRequestHandler(SKILLS_GET_METHOD);
        if (directoryRead) server.assertCanSetRequestHandler(RESOURCES_DIRECTORY_READ_METHOD);
        // Check before changing anything; declare the capability last, so a server never advertises skills it does not serve.
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
        server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: directoryRead ? { directoryRead: true } : {} } });
        this.#attached.add(mcp);
        skillsServers.add(mcp);
        afterAttach.get(this)?.(mcp);
    }

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

interface CatalogInit {
    readonly state: CatalogState;
    readonly files: SkillFiles;
    readonly build: CatalogBuildOptions;
    readonly sourceOptions: SkillSourceOptions;
}

// Fewest tracked servers at which `attach` drops references to collected ones; then again at twice the survivors.
const PRUNE_THRESHOLD = 1024;

function resolveLimits(limits: SkillCatalogOptions['limits']): { files: number; bytes: number } {
    const resolved = { files: limits?.files ?? SKILL_LIMITS.files, bytes: limits?.bytes ?? SKILL_LIMITS.bytes };
    for (const [name, value] of Object.entries(resolved)) {
        if (value !== Number.POSITIVE_INFINITY && !(Number.isSafeInteger(value) && value > 0)) {
            throw new RangeError(`limits.${name} must be a positive integer or Infinity (got ${value})`);
        }
    }
    return resolved;
}

// What `resources/list_changed` is about: which skills exist, and each one's name and description.
function listingKey(snapshot: CatalogSnapshot): string {
    return JSON.stringify(snapshot.listed.map(resource => [resource.uri, resource.name, resource.description]));
}

function diffSnapshots(previous: CatalogSnapshot, next: CatalogSnapshot): Omit<SkillCatalogChanges, 'listChanged'> {
    const same = (uri: string): boolean => JSON.stringify(previous.skills.get(uri)) === JSON.stringify(next.skills.get(uri));
    return {
        added: [...next.skills.keys()].filter(uri => !previous.skills.has(uri)),
        removed: [...previous.skills.keys()].filter(uri => !next.skills.has(uri)),
        changed: [...next.skills.keys()].filter(uri => previous.skills.has(uri) && !same(uri))
    };
}

/**
 * A catalog the SDK built from storage. It holds metadata only: every file
 * read goes through the adapter and is checked against the published entry.
 */
export class SkillCatalog extends SkillsExtension {
    readonly #state: CatalogState;
    readonly #files: SkillFiles;
    readonly #build: CatalogBuildOptions;
    readonly #servers = new Set<WeakRef<McpServer>>();
    #pruneAt = PRUNE_THRESHOLD;
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(init: CatalogInit) {
        super(init.sourceOptions);
        this.#state = init.state;
        this.#files = init.files;
        this.#build = init.build;
        afterAttach.set(this, mcp => this.#track(mcp));
    }

    static override async load(files: SkillFiles, options: SkillCatalogOptions = {}): Promise<SkillCatalog> {
        const pageSize = resolvePageSize(options.pageSize);
        const build: CatalogBuildOptions = {
            prefix: options.prefix === undefined ? [] : splitRelativePath(options.prefix, 'prefix'),
            limits: resolveLimits(options.limits),
            strict: options.strict ?? false,
            warn: options.onWarning ?? defaultWarn
        };
        const state: CatalogState = { current: await buildCatalogSnapshot(files, build) };
        return new SkillCatalog({
            state,
            files,
            build,
            sourceOptions: {
                source: catalogSource(state, files, pageSize, build.warn),
                baseUri: build.prefix.length === 0 ? 'skill://' : joinUri('skill://', build.prefix),
                cacheHint: options.cacheHint,
                strict: options.strict,
                onWarning: build.warn
            }
        });
    }

    /** The skills this catalog serves, sorted by URI. Frozen (deeply): they are exactly what clients receive. */
    get entries(): readonly Skill[] {
        return this.#state.current.ordered;
    }

    /**
     * Scans the storage again and swaps the new catalog in at once. All or
     * nothing: on failure the old catalog keeps serving. Overlapping calls run
     * one after another.
     *
     * When skills are added or removed, or a `SKILL.md`'s name or description
     * changes, the result has `listChanged: true` and `resources/list_changed`
     * goes out through every attached server that is still connected (stdio,
     * stateful 2025-11-25 HTTP sessions). Servers that `createMcpHandler` builds per
     * request are closed by then, so publish the change on the handler:
     * `if (changes.listChanged) handler.notify.resourcesChanged()`. Where the
     * runtime has no `WeakRef` (Cloudflare Workers with a compatibility date
     * before 2025-05-05), attached servers are not tracked and nothing is sent.
     */
    reload(): Promise<SkillCatalogChanges> {
        const run = this.#queue.then(() => this.#reloadNow());
        this.#queue = run.then(
            () => {},
            () => {}
        );
        return run;
    }

    #track(mcp: McpServer): void {
        // Without WeakRef, holding servers strongly would keep every per-request server alive; track none instead.
        if (typeof WeakRef !== 'function') return;
        if (this.#servers.size >= this.#pruneAt) {
            for (const reference of this.#servers) if (reference.deref() === undefined) this.#servers.delete(reference);
            this.#pruneAt = Math.max(PRUNE_THRESHOLD, 2 * this.#servers.size);
        }
        this.#servers.add(new WeakRef(mcp));
    }

    async #reloadNow(): Promise<SkillCatalogChanges> {
        const previous = this.#state.current;
        const next = await buildCatalogSnapshot(this.#files, this.#build);
        this.#state.current = next;
        const listChanged = listingKey(previous) !== listingKey(next);
        if (listChanged) this.#notify();
        return { ...diffSnapshots(previous, next), listChanged };
    }

    // A send that fails becomes a warning: never an unhandled rejection, and never a reason to skip the other servers.
    #notify(): void {
        for (const reference of this.#servers) {
            const mcp = reference.deref();
            if (mcp === undefined) {
                this.#servers.delete(reference);
                continue;
            }
            if (!mcp.isConnected()) continue;
            const sessionId = mcp.server.transport?.sessionId;
            try {
                // `Server.sendResourceListChanged` is async; `Promise.resolve` also covers a synchronous return.
                Promise.resolve(mcp.server.sendResourceListChanged()).catch((error: unknown) => this.#notifyFailed(sessionId, error));
            } catch (error) {
                this.#notifyFailed(sessionId, error);
            }
        }
    }

    #notifyFailed(sessionId: string | undefined, error: unknown): void {
        const to = sessionId === undefined ? '' : ` to session ${sessionId}`;
        const reason = error instanceof Error ? error.message : String(error);
        try {
            this.#build.warn({ path: 'resources/list_changed', message: `could not be sent${to}: ${reason}` });
        } catch {
            // A throwing onWarning must not escape either: it would reject reload() or go unhandled.
        }
    }
}
