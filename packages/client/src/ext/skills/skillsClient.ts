import type { DirectoryResource, Skill, SkillCacheScope, SkillResourceEntry } from '@modelcontextprotocol/core/ext/skills';
import {
    RESOURCES_DIRECTORY_READ_METHOD,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD,
    skillsCapabilityOf
} from '@modelcontextprotocol/core/ext/skills';
import { isModernProtocolVersion } from '@modelcontextprotocol/core-internal';
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
} from '@modelcontextprotocol/core-internal/ext/skills';
import type { ReadResourceResult, RequestOptions } from '@modelcontextprotocol/core-internal/public';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';
import type * as z from 'zod/v4';

import type { CacheableRequestOptions, Client } from '../../client/client';
import { clientInternals } from '../../client/client';
import type { InvalidSkillEntry } from './entries';
import { checkEntry, partitionEntries } from './entries';
import { SkillVerificationError } from './errors';
import { LEGACY_ENVELOPES, MODERN_ENVELOPES } from './pageSchemas';
import { frontmatterDifferences } from './verify';

export interface SkillsClientOptions {
    /**
     * Parses the YAML between a `SKILL.md`'s `---` lines (BOM and CRLF removed) for verification, instead of the
     * built-in parser (YAML 1.2 core-schema typing).
     */
    parseFrontmatter?: (yaml: string) => Record<string, unknown>;
    /** Return invalid `skills/list` entries in `invalid` instead of throwing. Default `false`: `list()` throws on any. */
    skipInvalid?: boolean;
}

/** What `list()` returns: the valid entries, the refused ones (only with `skipInvalid`), and the first page's caching fields. */
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

/** What `read` requests and checks: the file's URI and key, its listing, and whether it is the skill's own `SKILL.md`. */
interface ReadTarget {
    /** The entry's spelling of a listed file; for a `"dynamic"` skill, the URI the ref resolves to. */
    uri: string;
    root: string;
    /** The file's {@linkcode skillFileKey}: listings and returned contents are matched by it. */
    key: string;
    /** `undefined` for `"dynamic"` skills. */
    listed: SkillResourceEntry | undefined;
    manifest: boolean;
}

/**
 * Resolves `ref` against the skill root and drops its fragment. A listed file is found in the entry by
 * {@linkcode skillFileKey}, since servers percent-encode names differently (`Q&A.md`, `Q%26A.md`); a
 * `"dynamic"` skill's file is requested at the resolved URI, as nothing published another spelling.
 * Throws `unlisted` for a ref that does not parse or names no file of the skill.
 */
function resolveTarget(skill: Skill, ref: string | undefined): ReadTarget {
    const root = skillRootUri(skill.uri);
    if (root === undefined) throw new TypeError(`${skill.uri} is not a SKILL.md URI`);
    let uri: string;
    try {
        const resolved = new URL(resolveSkillRef(skill.uri, ref));
        resolved.hash = '';
        uri = resolved.href;
    } catch (error) {
        const given = ref ?? '';
        throw new SkillVerificationError('unlisted', given, `${given} is not a URI reference`, [], { cause: error });
    }
    const key = skillFileKey(root, uri) ?? uri;
    const manifest = key === skillFileKey(root, skill.uri);
    const notInSkill = () => new SkillVerificationError('unlisted', uri, `${uri} is not a file of the skill ${skill.uri}`);
    if (skill.resources === 'dynamic') {
        if (!manifest && !isWithin(root, key)) throw notInSkill();
        return { uri, root, key, listed: undefined, manifest };
    }
    const listed = skill.resources.find(resource => skillFileKey(root, resource.uri) === key);
    if (listed === undefined) throw notInSkill();
    return { uri: listed.uri, root, key, listed, manifest };
}

/** A result's `ttlMs` and `cacheScope`, where it has them (always, on 2026-07-28). */
function cacheFieldsOf(result: { ttlMs?: number; cacheScope?: SkillCacheScope }): { ttlMs?: number; cacheScope?: SkillCacheScope } {
    return {
        ...(result.ttlMs !== undefined && { ttlMs: result.ttlMs }),
        ...(result.cacheScope !== undefined && { cacheScope: result.cacheScope })
    };
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
        return !clientInternals.enforceStrictCapabilities(this.#client) || capabilities?.resources !== undefined;
    }

    /** The server serves `resources/directory/read`. */
    get directoryRead(): boolean {
        return this.supported && skillsCapabilityOf(this.#client.getServerCapabilities())?.directoryRead === true;
    }

    /**
     * Lists the server's skills, walking every page unless given a cursor
     * (bounded by the client's `listMaxPages`). Throws an `SdkError` naming
     * every invalid entry, and every copy of a repeated URI; with
     * `skipInvalid`, returns them in `invalid` instead. A 2026-07-28 page
     * without `ttlMs` and `cacheScope` throws either way. On a server without
     * the extension: an empty listing.
     */
    async list(params: { cursor?: string } = {}, options?: RequestOptions): Promise<SkillListing> {
        if (!this.supported) {
            if (clientInternals.enforceStrictCapabilities(this.#client)) throw unsupported(SKILLS_LIST_METHOD);
            // eslint-disable-next-line no-console
            console.debug(`SkillsClient.list() called but the server does not declare ${SKILLS_EXTENSION_ID} - returning an empty list`);
            return { skills: [], invalid: [] };
        }
        const page = await this.#pages(SKILLS_LIST_METHOD, this.#envelopes().list, {}, params.cursor, options, result => result.skills);
        const { skills, invalid } = partitionEntries(page.skills);
        if (invalid.length > 0 && !this.#options.skipInvalid) {
            const detail = invalid.map(entry => `#${entry.index} ${entry.uri ?? ''}: ${entry.reason}`).join('\n');
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/list returned invalid entries:\n${detail}`, { invalid });
        }
        return {
            skills,
            invalid,
            ...(params.cursor !== undefined && page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
            ...cacheFieldsOf(page)
        };
    }

    /**
     * One skill by its `SKILL.md` URI, listed or not, with the result's caching
     * fields on 2026-07-28. Throws if the server returns an invalid entry or
     * another skill.
     */
    async get(uri: string, options?: RequestOptions): Promise<{ skill: Skill; ttlMs?: number; cacheScope?: SkillCacheScope }> {
        if (!this.supported) throw unsupported(SKILLS_GET_METHOD);
        const result = await this.#client.request({ method: SKILLS_GET_METHOD, params: { uri } }, this.#envelopes().get, options);
        const { skill, problems } = checkEntry(result.skill);
        if (skill === undefined || problems.length > 0) {
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/get returned an invalid entry for ${uri}: ${problems.join('; ')}`);
        }
        if (canonicalUri(skill.uri) !== canonicalUri(uri)) {
            throw new SdkError(SdkErrorCode.InvalidResult, `skills/get for ${uri} returned ${skill.uri}`);
        }
        return { skill, ...cacheFieldsOf(result) };
    }

    /**
     * Reads one file of `skill` and verifies it. `ref` is a path relative to
     * the skill's root (`references/FORMS.md`) or an absolute URI; the
     * default is the skill's own `SKILL.md`; a fragment is ignored. The file
     * must be listed in the entry (checked before any request, however either
     * side percent-encodes the name) and is requested by the entry's URI; its
     * size and digest must match;
     * for the skill's own `SKILL.md` the frontmatter must also equal the
     * entry's. A copy from the client's response cache that fails a check is
     * fetched once more with `cacheMode: 'refresh'`. `"dynamic"` skills skip
     * the listing, size and digest checks (`verified: false`) but not the
     * frontmatter. Pass entries from {@linkcode SkillsClient.list} or
     * {@linkcode SkillsClient.get}; an invalid entry throws a `TypeError`
     * before any request.
     *
     * @throws {SkillVerificationError} when a check fails.
     */
    async read(skill: Skill, ref?: string, options?: CacheableRequestOptions): Promise<SkillFile> {
        if (!this.supported) throw unsupported('resources/read');
        const { problems } = checkEntry(skill);
        if (problems.length > 0) throw new TypeError(`${skill.uri} is not a valid skill entry: ${problems.join('; ')}`);
        const target = resolveTarget(skill, ref);
        const params = { uri: target.uri };
        const { result, cached } = await clientInternals.readResource(this.#client, params, options);
        try {
            return await this.#verify(skill, target, result);
        } catch (error) {
            if (!(error instanceof SkillVerificationError) || !cached) throw error;
            // A cached copy that fails verification must be fetched again (SEP-2640).
            return this.#verify(skill, target, await this.#client.readResource(params, { ...options, cacheMode: 'refresh' }));
        }
    }

    async #verify(skill: Skill, target: ReadTarget, result: ReadResourceResult): Promise<SkillFile> {
        const { uri, root, key, listed } = target;
        const content = result.contents.find(item => (skillFileKey(root, item.uri) ?? item.uri) === key);
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
            if (parse === undefined) return parseSkillMarkdown(markdown);
            const { yaml, body } = splitFrontmatter(markdown);
            return { frontmatter: parse(yaml), body };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new SkillVerificationError('frontmatter', uri, `the frontmatter of ${uri} cannot be read: ${reason}`, [], {
                cause: error
            });
        }
    }

    /**
     * The direct children of a skill directory, every page walked, with the
     * first page's caching fields on 2026-07-28. Needs `directoryRead`.
     */
    async readDirectory(
        uri: string,
        options?: RequestOptions
    ): Promise<{ resources: DirectoryResource[]; ttlMs?: number; cacheScope?: SkillCacheScope }> {
        if (!this.directoryRead) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Server does not declare directoryRead for ${SKILLS_EXTENSION_ID} (required for ${RESOURCES_DIRECTORY_READ_METHOD})`
            );
        }
        const page = await this.#pages(
            RESOURCES_DIRECTORY_READ_METHOD,
            this.#envelopes().directory,
            { uri },
            undefined,
            options,
            result => result.resources
        );
        return { resources: page.resources, ...cacheFieldsOf(page) };
    }

    /** The result envelopes for the negotiated version. */
    #envelopes(): typeof LEGACY_ENVELOPES | typeof MODERN_ENVELOPES {
        return isModernProtocolVersion(this.#client.getNegotiatedProtocolVersion() ?? '') ? MODERN_ENVELOPES : LEGACY_ENVELOPES;
    }

    /** One page (with `cursor`), or every page in one, walked as Client walks its own list verbs. */
    #pages<T extends { nextCursor?: string }>(
        method: string,
        schema: z.ZodType<T>,
        params: Record<string, unknown>,
        cursor: string | undefined,
        options: RequestOptions | undefined,
        items: (page: T) => unknown[]
    ): Promise<T> {
        const fetchPage = (at: string | undefined): Promise<T> =>
            this.#client.request({ method, params: at === undefined ? params : { ...params, cursor: at } }, schema, options);
        return cursor === undefined ? clientInternals.walkPages(this.#client, method, fetchPage, items) : fetchPage(cursor);
    }
}
