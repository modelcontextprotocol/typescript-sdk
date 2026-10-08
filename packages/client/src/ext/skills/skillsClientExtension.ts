/**
 * `SkillsClientExtension` — the client side of the MCP Skills extension
 * (`io.modelcontextprotocol/skills`, SEP-2640) as a {@linkcode ClientExtension}.
 * It wraps `skills/list`, `skills/get` and `resources/directory/read`, each
 * refused unless the server declared support, and `read`, which fetches a
 * skill file with `resources/read` and verifies it against the skill's entry.
 *
 * ```ts
 * const skills = new SkillsClientExtension();
 * const client = new Client(info, { extensions: [skills] });
 * await client.connect(transport);
 *
 * const { skills: entries } = await skills.list();
 * const manifest = await skills.read(entries[0], entries[0].uri);
 * ```
 *
 * One extension instance serves one client: `install` binds it.
 */

import type { BlobResourceContents, RequestOptions, TextResourceContents } from '@modelcontextprotocol/core-internal';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import type {
    GetSkillResult,
    ListSkillsParams,
    ListSkillsResult,
    ReadResourceDirectoryResult,
    Skill,
    SkillsExtensionCapability
} from '@modelcontextprotocol/core-internal/ext/skills';
import {
    getSkillResultSchema,
    listSkillsResultSchema,
    readResourceDirectoryResultSchema,
    skillDigest,
    skillFileBytes,
    SKILLS_EXTENSION_ID,
    skillsExtensionCapabilitySchema
} from '@modelcontextprotocol/core-internal/ext/skills';

import type { Client } from '../../client/client';
import type { ClientExtension } from '../../client/extension';

const verificationFailure = (uri: string, reason: string): never => {
    throw new SdkError(SdkErrorCode.InvalidResult, `Skill file ${uri} failed verification: ${reason}`);
};

const rawBytes = (content: TextResourceContents | BlobResourceContents): Uint8Array =>
    'blob' in content ? Uint8Array.from(atob(content.blob), char => char.codePointAt(0) ?? 0) : skillFileBytes(content.text);

export class SkillsClientExtension implements ClientExtension {
    readonly id = SKILLS_EXTENSION_ID;
    #client: Client | undefined;

    install(client: Client): void {
        if (this.#client !== undefined) throw new Error('SkillsClientExtension is already installed on a client');
        this.#client = client;
    }

    get client(): Client {
        if (this.#client === undefined) throw new SdkError(SdkErrorCode.NotConnected, 'SkillsClientExtension is not installed on a client');
        return this.#client;
    }

    /** The extension settings the server declared, or `undefined` when it declared none. */
    get capability(): SkillsExtensionCapability | undefined {
        const declared = this.client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID];
        const parsed = skillsExtensionCapabilitySchema.safeParse(declared);
        return parsed.success ? parsed.data : undefined;
    }

    /** `skills/list`: one page of entries. Pass `nextCursor` back as `cursor` for the next. */
    async list(params?: ListSkillsParams, options?: RequestOptions): Promise<ListSkillsResult> {
        this.#require('skills/list');
        return (await this.client.request(
            { method: 'skills/list', params: { ...params } },
            listSkillsResultSchema,
            options
        )) as ListSkillsResult;
    }

    /** `skills/get`: the entry for the skill whose `SKILL.md` is at `uri`, listed or not. */
    async get(uri: string, options?: RequestOptions): Promise<GetSkillResult> {
        this.#require('skills/get');
        return (await this.client.request({ method: 'skills/get', params: { uri } }, getSkillResultSchema, options)) as GetSkillResult;
    }

    /** `resources/directory/read`: the direct children of a directory resource. Refused unless the server declared `directoryRead`. */
    async readDirectory(uri: string, cursor?: string, options?: RequestOptions): Promise<ReadResourceDirectoryResult> {
        this.#require('resources/directory/read');
        if (this.capability?.directoryRead !== true) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'Server does not support resources/directory/read');
        }
        const params = { uri, ...(cursor !== undefined && { cursor }) };
        return (await this.client.request(
            { method: 'resources/directory/read', params },
            readResourceDirectoryResultSchema,
            options
        )) as ReadResourceDirectoryResult;
    }

    /**
     * Reads one of `skill`'s files and verifies it against the entry: the file
     * must be listed, and its size and digest must match. Throws `InvalidResult`
     * on any mismatch. A `"dynamic"` skill has nothing to verify against, so its
     * files are returned as read. Comparing a `SKILL.md`'s frontmatter with the
     * entry needs a YAML parser and is left to the host.
     */
    async read(skill: Skill, uri: string, options?: RequestOptions): Promise<TextResourceContents | BlobResourceContents> {
        const listed = skill.resources === 'dynamic' ? undefined : skill.resources.find(resource => resource.uri === uri);
        if (skill.resources !== 'dynamic' && listed === undefined) verificationFailure(uri, `not listed in ${skill.uri}`);

        const { contents } = await this.client.readResource({ uri }, options);
        const content = contents.find(item => item.uri === uri) ?? verificationFailure(uri, 'not in the resources/read result');
        if (listed === undefined) return content;

        const bytes = rawBytes(content);
        if (bytes.byteLength !== listed.size) verificationFailure(uri, `size ${bytes.byteLength}, entry says ${listed.size}`);
        if ((await skillDigest(bytes)) !== listed.digest) verificationFailure(uri, 'digest mismatch');
        return content;
    }

    #require(method: string): void {
        if (this.capability === undefined) {
            throw new SdkError(
                SdkErrorCode.CapabilityNotSupported,
                `Server does not support the ${SKILLS_EXTENSION_ID} extension (${method})`
            );
        }
        if (this.client.getServerCapabilities()?.resources === undefined) {
            throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server declares ${SKILLS_EXTENSION_ID} without resources (${method})`);
        }
    }
}
