import type { DirectoryResource, Skill, SkillCacheScope } from '@modelcontextprotocol/core/ext/skills';
import {
    ReadResourceDirectoryResultSchema,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD,
    skillsCapabilityOf
} from '@modelcontextprotocol/core/ext/skills';
import { canonicalUri } from '@modelcontextprotocol/core-internal';
import type { RequestOptions } from '@modelcontextprotocol/core-internal/public';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';
import type * as z from 'zod/v4';

import type { Client } from '../../client/client';
import { clientSettings } from './clientInternals';
import type { InvalidSkillEntry } from './entries';
import { checkEntry, partitionEntries } from './entries';
import { GetSkillEnvelopeSchema, SkillsPageSchema } from './pageSchemas';

export interface SkillsClientOptions {
    /** Parses a `SKILL.md`'s frontmatter for verification instead of the built-in YAML parser. */
    parseFrontmatter?: (skillMd: string) => Record<string, unknown>;
    /** Throw when `list()` meets an invalid entry instead of returning it in `invalid`. Default `false`. */
    strict?: boolean;
}

/** What `list()` returns: the valid entries, the refused ones, and the first page's caching fields. */
export interface SkillListing {
    skills: Skill[];
    invalid: InvalidSkillEntry[];
    /** Only when `list()` was given a cursor (one page); a full walk has none. */
    nextCursor?: string;
    ttlMs?: number;
    cacheScope?: SkillCacheScope;
}

function unsupported(method: string): SdkError {
    return new SdkError(
        SdkErrorCode.CapabilityNotSupported,
        `Server does not support the ${SKILLS_EXTENSION_ID} extension (required for ${method})`
    );
}

/**
 * Host side of the MCP Skills extension (SEP-2640): lists, gets and reads a
 * server's skills, and verifies every file against the server's entry.
 * Approval, origin tagging and loading policy stay with the host.
 *
 * @example
 * ```ts
 * const skills = new SkillsClient(client);
 * const { skills: entries } = await skills.list();
 * const manifest = await skills.read(entries[0]!);
 * ```
 */
export class SkillsClient {
    readonly #client: Client;
    readonly #options: SkillsClientOptions;

    constructor(client: Client, options: SkillsClientOptions = {}) {
        this.#client = client;
        this.#options = options;
    }

    /** The server declared the extension (and `resources`, under `enforceStrictCapabilities`). `false` before connect. */
    get supported(): boolean {
        const capabilities = this.#client.getServerCapabilities();
        if (skillsCapabilityOf(capabilities) === undefined) return false;
        return !clientSettings(this.#client).enforceStrictCapabilities || capabilities?.resources !== undefined;
    }

    /** The server serves `resources/directory/read`. */
    get directoryRead(): boolean {
        return this.supported && skillsCapabilityOf(this.#client.getServerCapabilities())?.directoryRead === true;
    }

    /**
     * Lists the server's skills, walking every page unless given a cursor
     * (bounded by the client's `listMaxPages`). Invalid entries, and every
     * copy of a repeated URI, are returned in `invalid` (or thrown under
     * `strict`). On a server without the extension: an empty listing.
     */
    async list(params: { cursor?: string } = {}, options?: RequestOptions): Promise<SkillListing> {
        if (!this.supported) {
            if (clientSettings(this.#client).enforceStrictCapabilities) throw unsupported(SKILLS_LIST_METHOD);
            // eslint-disable-next-line no-console
            console.debug(`SkillsClient.list() called but the server does not declare ${SKILLS_EXTENSION_ID} - returning an empty list`);
            return { skills: [], invalid: [] };
        }
        const pages = await this.#pages(SKILLS_LIST_METHOD, SkillsPageSchema, {}, params.cursor, options);
        const { skills, invalid } = partitionEntries(pages.flatMap(page => page.skills));
        if (invalid.length > 0 && this.#options.strict) {
            const detail = invalid.map(entry => `#${entry.index} ${entry.uri ?? ''}: ${entry.reason}`).join('\n');
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/list returned invalid entries:\n${detail}`, { invalid });
        }
        const first = pages[0]!;
        const last = pages.at(-1)!;
        return {
            skills,
            invalid,
            ...(params.cursor !== undefined && last.nextCursor !== undefined && { nextCursor: last.nextCursor }),
            ...(first.ttlMs !== undefined && { ttlMs: first.ttlMs }),
            ...(first.cacheScope !== undefined && { cacheScope: first.cacheScope })
        };
    }

    /** One skill by its `SKILL.md` URI, listed or not. Throws if the server returns an invalid entry or another skill. */
    async get(uri: string, options?: RequestOptions): Promise<Skill> {
        if (!this.supported) throw unsupported(SKILLS_GET_METHOD);
        const result = await this.#client.request({ method: SKILLS_GET_METHOD, params: { uri } }, GetSkillEnvelopeSchema, options);
        const { skill, problems } = checkEntry(result.skill);
        if (skill === undefined || problems.length > 0) {
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/get returned an invalid entry for ${uri}: ${problems.join('; ')}`);
        }
        if (canonicalUri(skill.uri) !== canonicalUri(uri)) {
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/get for ${uri} returned ${skill.uri}`);
        }
        return skill;
    }

    /** The direct children of a skill directory, every page walked. Needs `directoryRead`. */
    async readDirectory(uri: string, options?: RequestOptions): Promise<DirectoryResource[]> {
        if (!this.directoryRead) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Server does not declare directoryRead for ${SKILLS_EXTENSION_ID} (required for ${RESOURCES_DIRECTORY_READ_METHOD})`
            );
        }
        const pages = await this.#pages(RESOURCES_DIRECTORY_READ_METHOD, ReadResourceDirectoryResultSchema, { uri }, undefined, options);
        return pages.flatMap(page => page.resources);
    }

    /** One page (with `cursor`) or every page: stops at a repeated cursor, throws past `listMaxPages`. */
    async #pages<T extends { nextCursor?: string }>(
        method: string,
        schema: z.ZodType<T>,
        params: Record<string, unknown>,
        cursor: string | undefined,
        options: RequestOptions | undefined
    ): Promise<T[]> {
        const fetchPage = (at: string | undefined): Promise<T> =>
            this.#client.request({ method, params: at === undefined ? params : { ...params, cursor: at } }, schema, options);
        if (cursor !== undefined) return [await fetchPage(cursor)];
        const { listMaxPages } = clientSettings(this.#client);
        const pages = [await fetchPage(undefined)];
        const seen = new Set<string>();
        let next = pages[0]!.nextCursor;
        while (next !== undefined && !seen.has(next)) {
            if (listMaxPages !== 0 && pages.length >= listMaxPages) {
                throw new SdkError(
                    SdkErrorCode.ListPaginationExceeded,
                    `${method}: exceeded listMaxPages (${listMaxPages}); server pagination did not terminate`,
                    { method, listMaxPages }
                );
            }
            seen.add(next);
            const page = await fetchPage(next);
            pages.push(page);
            next = page.nextCursor;
        }
        return pages;
    }
}
