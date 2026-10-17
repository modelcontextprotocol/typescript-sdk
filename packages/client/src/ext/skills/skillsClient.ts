import type { DirectoryResource, Skill, SkillCacheScope, SkillResourceEntry } from '@modelcontextprotocol/core/ext/skills';
import {
    ReadResourceDirectoryResultSchema,
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD,
    skillsCapabilityOf
} from '@modelcontextprotocol/core/ext/skills';
import {
    canonicalUri,
    decodeBase64,
    decodeUtf8Lossless,
    encodeUtf8,
    isWithin,
    parseSkillMarkdown,
    resolveSkillRef,
    sha256Digest,
    skillFileKey,
    skillRootUri,
    splitFrontmatter
} from '@modelcontextprotocol/core-internal';
import type { RequestOptions } from '@modelcontextprotocol/core-internal/public';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';
import type * as z from 'zod/v4';

import type { CacheableRequestOptions, Client } from '../../client/client';
import { clientSettings } from './clientInternals';
import type { InvalidSkillEntry } from './entries';
import { checkEntry, partitionEntries } from './entries';
import { SkillVerificationError } from './errors';
import { GetSkillEnvelopeSchema, SkillsPageSchema } from './pageSchemas';
import { frontmatterDifferences } from './verify';

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

/** A skill file as read and checked by {@linkcode SkillsClient.read}. */
export interface SkillFile {
    /** The URI requested: the entry's spelling of the file; for `"dynamic"` skills, the resolved ref in its normalised form. */
    uri: string;
    mimeType?: string;
    /** Exactly the bytes the entry's digest covers. */
    bytes: Uint8Array;
    /** When the server sent text (always, for the skill's own `SKILL.md`). */
    text?: string;
    /** Size and digest were checked. `false` only for `"dynamic"` skills. */
    verified: boolean;
    /** The skill's own `SKILL.md` only: its parsed frontmatter, equal to the entry's. */
    frontmatter?: Record<string, unknown>;
    /** The skill's own `SKILL.md` only: the markdown after the frontmatter. */
    body?: string;
}

function decodeBlob(uri: string, blob: string): Uint8Array {
    try {
        return decodeBase64(blob);
    } catch (error) {
        throw new SdkError(SdkErrorCode.InvalidResult, `resources/read returned an invalid base64 blob for ${uri}`, undefined, {
            cause: error
        });
    }
}

/** What `read` requests and checks: the entry's spelling of the file, its listing, and whether it is the skill's own `SKILL.md`. */
interface ReadTarget {
    uri: string;
    /** `undefined` for `"dynamic"` skills. */
    listed: SkillResourceEntry | undefined;
    manifest: boolean;
}

/**
 * Resolves `ref` against the skill root, drops its fragment, and finds the file in the entry: by its exact spelling
 * first, then by {@linkcode skillFileKey}, since servers percent-encode names differently (`Q&A.md`, `Q%26A.md`).
 * Throws `unlisted` for a ref that does not parse or names no file of the skill.
 */
function resolveTarget(skill: Skill, ref: string | undefined): ReadTarget {
    const root = skillRootUri(skill.uri);
    if (root === undefined) throw new TypeError(`${skill.uri} is not a SKILL.md URI`);
    let uri: string;
    try {
        uri = resolveSkillRef(skill.uri, ref);
    } catch (error) {
        const given = ref ?? '';
        throw new SkillVerificationError('unlisted', given, `${given} is not a URI reference`, [], { cause: error });
    }
    const key = skillFileKey(root, uri) ?? uri;
    const manifest = key === skillFileKey(root, skill.uri);
    const notInSkill = () => new SkillVerificationError('unlisted', uri, `${uri} is not a file of the skill ${skill.uri}`);
    if (skill.resources === 'dynamic') {
        if (!manifest && !isWithin(root, key)) throw notInSkill();
        return { uri: key, listed: undefined, manifest };
    }
    const { resources } = skill;
    const hash = uri.indexOf('#');
    const exact = hash === -1 ? uri : uri.slice(0, hash);
    const listed =
        resources.find(resource => canonicalUri(resource.uri) === exact) ??
        resources.find(resource => skillFileKey(root, resource.uri) === key);
    if (listed === undefined) throw notInSkill();
    return { uri: listed.uri, listed, manifest };
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

    /**
     * Reads one file of `skill` and verifies it. `ref` is a path relative to
     * the skill's root (`references/FORMS.md`) or an absolute URI; the
     * default is the skill's own `SKILL.md`; a fragment is ignored. The file
     * must be listed in the entry (checked before any request, however either
     * side percent-encodes the name) and is requested by the entry's URI; its
     * size and digest must match;
     * for the skill's own `SKILL.md` the frontmatter must also equal the
     * entry's. A failed check on what may be a cached copy is fetched once
     * more with `cacheMode: 'refresh'`. `"dynamic"` skills skip the listing,
     * size and digest checks (`verified: false`) but not the frontmatter.
     * Pass entries from {@linkcode SkillsClient.list} or {@linkcode SkillsClient.get}.
     *
     * @throws {SkillVerificationError} when a check fails.
     */
    async read(skill: Skill, ref?: string, options?: CacheableRequestOptions): Promise<SkillFile> {
        if (!this.supported) throw unsupported('resources/read');
        const target = resolveTarget(skill, ref);
        try {
            return await this.#readVerified(skill, target, options);
        } catch (error) {
            const mayBeCached = options?.cacheMode === undefined || options.cacheMode === 'use';
            if (!(error instanceof SkillVerificationError) || !mayBeCached) throw error;
            // The failing copy may have come from the response cache; the spec requires fetching it again.
            return this.#readVerified(skill, target, { ...options, cacheMode: 'refresh' });
        }
    }

    async #readVerified(skill: Skill, target: ReadTarget, options: CacheableRequestOptions | undefined): Promise<SkillFile> {
        const { uri, listed } = target;
        const result = await this.#client.readResource({ uri }, options);
        const content = result.contents.find(item => canonicalUri(item.uri) === canonicalUri(uri)) ?? result.contents[0];
        if (content === undefined) throw new SdkError(SdkErrorCode.InvalidResult, `resources/read returned no contents for ${uri}`);
        const bytes = 'text' in content ? encodeUtf8(content.text) : decodeBlob(uri, content.blob);
        if (listed !== undefined) {
            if (bytes.byteLength !== listed.size) {
                throw new SkillVerificationError('size', uri, `${uri} is ${bytes.byteLength} bytes; the skill entry lists ${listed.size}`);
            }
            const digest = await sha256Digest(bytes);
            if (digest !== listed.digest) {
                throw new SkillVerificationError('digest', uri, `${uri} has digest ${digest}; the skill entry lists ${listed.digest}`);
            }
        }
        const file: SkillFile = {
            uri,
            ...(content.mimeType !== undefined && { mimeType: content.mimeType }),
            bytes,
            ...('text' in content && { text: content.text }),
            verified: listed !== undefined
        };
        if (!target.manifest) return file;
        const markdown = 'text' in content ? content.text : decodeUtf8Lossless(bytes);
        if (markdown === undefined) throw new SkillVerificationError('frontmatter', uri, `${uri} is not valid UTF-8`);
        const { frontmatter, body } = this.#parse(uri, markdown);
        const differences = frontmatterDifferences(skill.frontmatter, frontmatter);
        if (differences.length > 0) {
            throw new SkillVerificationError(
                'frontmatter',
                uri,
                `the frontmatter of ${uri} differs from the skill entry: ${differences.join('; ')}`,
                differences
            );
        }
        return { ...file, text: markdown, frontmatter, body };
    }

    #parse(uri: string, markdown: string): { frontmatter: Record<string, unknown>; body: string } {
        try {
            const parse = this.#options.parseFrontmatter;
            return parse === undefined
                ? parseSkillMarkdown(markdown)
                : { frontmatter: parse(markdown), body: splitFrontmatter(markdown).body };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new SkillVerificationError('frontmatter', uri, `the frontmatter of ${uri} cannot be read: ${reason}`, [], {
                cause: error
            });
        }
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
