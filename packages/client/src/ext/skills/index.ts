// @modelcontextprotocol/client/ext/skills
//
// Client operations for the MCP Skills extension (SEP-2640): thin, typed
// wrappers over `skills/list` and `skills/get` that gate on capability
// negotiation and validate results against the shared schemas in
// `@modelcontextprotocol/core/ext/skills`.
//
// Adapted, with attribution, from the Apache-2.0 `@olaservo/ext-skills`
// prototype (modelcontextprotocol/ext-skills#71); the wire shapes follow the
// final SEP rather than the prototype's earlier vocabulary.

import type {
    GetSkillRequestParams,
    GetSkillResult,
    ListSkillsRequestParams,
    ListSkillsResult,
    SkillsCapability
} from '@modelcontextprotocol/core/ext/skills';
import {
    GetSkillResultSchema,
    ListSkillsResultSchema,
    SKILLS_EXTENSION_ID,
    SKILLS_GET_METHOD,
    SKILLS_LIST_METHOD,
    skillsCapabilityOf
} from '@modelcontextprotocol/core/ext/skills';
import type { RequestOptions } from '@modelcontextprotocol/core-internal/public';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import type { Client } from '../../client/client';

/**
 * The Skills extension capability the connected server advertised, or
 * `undefined` when it advertised none (or is not connected yet).
 *
 * @example
 * ```ts
 * if (getSkillsCapability(client)?.directoryRead) {
 *     // the server also serves resources/directory/read
 * }
 * ```
 */
export function getSkillsCapability(client: Client): SkillsCapability | undefined {
    return skillsCapabilityOf(client.getServerCapabilities());
}

/**
 * Throws unless the server advertised both the Skills extension and the
 * `resources` capability. SEP-2640 requires servers to declare `resources`
 * alongside the extension, because every skill entry points at resource URIs
 * the host reads through `resources/read`.
 */
function assertSkillsSupported(client: Client, method: string): void {
    const capabilities = client.getServerCapabilities();
    if (skillsCapabilityOf(capabilities) === undefined) {
        throw new SdkError(
            SdkErrorCode.CapabilityNotSupported,
            `Server does not support the ${SKILLS_EXTENSION_ID} extension (required for ${method})`
        );
    }
    if (!capabilities?.resources) {
        throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
    }
}

/**
 * Fetches one page of the skills a server serves.
 *
 * This is the per-page call: pass the previous result's `nextCursor` back as
 * `params.cursor` to walk pagination, and stop when a result carries no
 * `nextCursor`. A single skill entry is never split across pages.
 *
 * @throws {SdkError} `CapabilityNotSupported` when the server advertised
 * neither the Skills extension nor `resources`.
 *
 * @example
 * ```ts
 * let cursor: string | undefined;
 * const skills = [];
 * do {
 *     const page = await listSkills(client, { cursor });
 *     skills.push(...page.skills);
 *     cursor = page.nextCursor;
 * } while (cursor !== undefined);
 * ```
 */
export async function listSkills(client: Client, params?: ListSkillsRequestParams, options?: RequestOptions): Promise<ListSkillsResult> {
    assertSkillsSupported(client, SKILLS_LIST_METHOD);
    return client.request({ method: SKILLS_LIST_METHOD, params }, ListSkillsResultSchema, options);
}

/**
 * Fetches a single skill by the URI of its `SKILL.md`.
 *
 * A server answers for every skill it serves, whether or not that skill
 * appears in `skills/list`. A URI that names no served skill — or that is not
 * a `SKILL.md` URI — comes back as a JSON-RPC `-32602` Invalid params error.
 *
 * @throws {SdkError} `CapabilityNotSupported` when the server advertised
 * neither the Skills extension nor `resources`.
 */
export async function getSkill(client: Client, params: GetSkillRequestParams, options?: RequestOptions): Promise<GetSkillResult> {
    assertSkillsSupported(client, SKILLS_GET_METHOD);
    return client.request({ method: SKILLS_GET_METHOD, params }, GetSkillResultSchema, options);
}
