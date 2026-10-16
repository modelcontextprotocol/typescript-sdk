// @modelcontextprotocol/server/ext/skills
//
// Server side of the MCP Skills extension (SEP-2640): declares the
// `io.modelcontextprotocol/skills` capability and serves `skills/list` and
// `skills/get` from a caller-provided set of skill definitions.
//
// Adapted, with attribution, from the Apache-2.0 `@olaservo/ext-skills`
// prototype (modelcontextprotocol/ext-skills#71); the wire shapes follow the
// final SEP rather than the prototype's earlier vocabulary.
//
// Scope: this phase serves skill *metadata* only. The files a skill entry
// points at stay ordinary MCP resources, registered and read the usual way —
// filesystem discovery and digest-verified reads are separate concerns.

import type { ListSkillsResult, Skill, SkillCacheScope } from '@modelcontextprotocol/core/ext/skills';
import {
    GetSkillRequestParamsSchema,
    GetSkillResultSchema,
    ListSkillsRequestParamsSchema,
    ListSkillsResultSchema,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD
} from '@modelcontextprotocol/core/ext/skills';
import { isModernProtocolVersion } from '@modelcontextprotocol/core-internal';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal/public';

import type { Server } from '../../server/server';

/**
 * Cache freshness hints stamped onto skills results.
 *
 * SEP-2640 makes `ttlMs` / `cacheScope` part of the skills results from
 * protocol revision 2026-07-28 onward. The SDK's own cache-fill seam covers a
 * closed set of six core operations and deliberately does not extend to
 * extension methods, so the extension supplies its own values here.
 */
export interface SkillsCacheHint {
    /** Milliseconds after which a client should refresh. Defaults to `0`. */
    ttlMs?: number;
    /** Cache scope for the result. Defaults to `'private'`. */
    cacheScope?: SkillCacheScope;
}

/** Options for {@linkcode installSkills}. */
export interface InstallSkillsOptions {
    /**
     * The skills this server serves, in the order `skills/list` should return
     * them. Every entry's `uri` must be unique — it is the key `skills/get`
     * resolves against.
     */
    skills: readonly Skill[];

    /**
     * How many skills a single `skills/list` page may carry. When set, results
     * beyond the page are reached through `nextCursor`. Unset means one page.
     */
    pageSize?: number;

    /**
     * Cache hints for `skills/list` and `skills/get` on protocol revision
     * 2026-07-28 onward. Defaults to `ttlMs: 0` and `cacheScope: 'private'`;
     * omitted entirely from responses on older protocol revisions.
     */
    cacheHint?: SkillsCacheHint;
}

/** Handle returned by {@linkcode installSkills}. */
export interface SkillsRegistration {
    /** The skills being served, keyed by `SKILL.md` URI. */
    readonly skills: ReadonlyMap<string, Skill>;
}

/** Decodes an opaque `skills/list` cursor into the offset it encodes. */
function offsetFromCursor(cursor: string | undefined, total: number): number {
    if (cursor === undefined) {
        return 0;
    }
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid cursor: ${cursor}`);
    }
    return offset;
}

/**
 * Declares the `io.modelcontextprotocol/skills` capability and registers
 * handlers for `skills/list` and `skills/get`.
 *
 * Must be called before the server connects to a transport — capabilities
 * cannot be registered afterwards. The caller is responsible for registering
 * the skills' files as resources (and for the `resources` capability SEP-2640
 * requires alongside the extension).
 *
 * @example
 * ```ts
 * const mcpServer = new McpServer({ name: 'skills-demo', version: '1.0.0' }, { capabilities: { resources: {} } });
 *
 * installSkills(mcpServer.server, {
 *     skills: [
 *         {
 *             uri: 'skill://git-workflow/SKILL.md',
 *             frontmatter: { name: 'git-workflow', description: 'Conventions for branching and review.' },
 *             resources: [{ uri: 'skill://git-workflow/SKILL.md', digest: `sha256:${sha}`, size: bytes.byteLength }]
 *         }
 *     ]
 * });
 * ```
 */
export function installSkills(server: Server, options: InstallSkillsOptions): SkillsRegistration {
    const { skills, pageSize, cacheHint } = options;

    if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1)) {
        throw new RangeError(`installSkills: pageSize must be a positive integer (got ${String(pageSize)})`);
    }

    const byUri = new Map<string, Skill>();
    for (const skill of skills) {
        if (byUri.has(skill.uri)) {
            throw new Error(`installSkills: duplicate skill URI ${skill.uri}`);
        }
        byUri.set(skill.uri, skill);
    }
    const ordered = [...byUri.values()];

    server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

    const hints = { ttlMs: cacheHint?.ttlMs ?? 0, cacheScope: cacheHint?.cacheScope ?? 'private' };
    // Resolve at request time: installation precedes protocol negotiation.
    // Use the instance's negotiated era, not caller-supplied request metadata.
    const hintsForRequest = () => (isModernProtocolVersion(server.getNegotiatedProtocolVersion() ?? '') ? hints : {});

    server.setRequestHandler(
        SKILLS_LIST_METHOD,
        { params: ListSkillsRequestParamsSchema, result: ListSkillsResultSchema },
        (params): ListSkillsResult => {
            const start = offsetFromCursor(params?.cursor, ordered.length);
            const end = pageSize === undefined ? ordered.length : Math.min(start + pageSize, ordered.length);
            const page = ordered.slice(start, end);
            return {
                skills: page,
                ...(end < ordered.length ? { nextCursor: String(end) } : {}),
                ...hintsForRequest()
            };
        }
    );

    server.setRequestHandler(SKILLS_GET_METHOD, { params: GetSkillRequestParamsSchema, result: GetSkillResultSchema }, params => {
        const skill = byUri.get(params.uri);
        if (skill === undefined) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${params.uri}`);
        }
        return { skill, ...hintsForRequest() };
    });

    return { skills: byUri };
}
