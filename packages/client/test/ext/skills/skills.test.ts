/**
 * SEP-2640 Skills extension, client side: capability gating, `skills/list`
 * pagination, `skills/get`, error propagation — and the typescript-sdk#2789
 * regression, where a spec-conforming `resultType: "complete"` body must parse
 * rather than fail validation.
 */
import type { JSONRPCRequest, ServerCapabilities } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import { SKILLS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/skills';
import { describe, expect, it } from 'vitest';

import { Client } from '../../../src/client/client';
import { getSkill, getSkillsCapability, listSkills } from '../../../src/ext/skills';

const MODERN = '2026-07-28';

const digest = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const skill = (name: string): Skill => ({
    uri: `skill://${name}/SKILL.md`,
    frontmatter: { name, description: `The ${name} skill.` },
    resources: [{ uri: `skill://${name}/SKILL.md`, digest: digest('a'), size: 64 }]
});

const SKILLS_CAPABLE: ServerCapabilities = {
    resources: {},
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } }
};

/**
 * A scripted modern-era server. Every result body carries `resultType:
 * "complete"` exactly as a spec-conforming server does — the condition
 * typescript-sdk#2789 reported as unparseable.
 */
async function connectedClient(
    capabilities: ServerCapabilities,
    pages: Skill[][] = [[skill('alpha')]]
): Promise<{ client: Client; listParams: Array<Record<string, unknown> | undefined> }> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const listParams: Array<Record<string, unknown> | undefined> = [];

    serverTx.onmessage = m => {
        const r = m as JSONRPCRequest;
        if (r.id === undefined) return;
        const send = (result: Record<string, unknown>) =>
            void serverTx.send({ jsonrpc: '2.0', id: r.id, result: { resultType: 'complete', ...result } });

        if (r.method === 'server/discover') {
            send({
                supportedVersions: [MODERN],
                capabilities,
                _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'skills-scripted', version: '1.0.0' } }
            });
        } else if (r.method === 'skills/list') {
            const params = r.params as Record<string, unknown> | undefined;
            listParams.push(params);
            const index = params?.['cursor'] === undefined ? 0 : Number(params['cursor']);
            const next = index + 1 < pages.length ? String(index + 1) : undefined;
            send({
                skills: pages[index] ?? [],
                ttlMs: 60_000,
                cacheScope: 'public',
                ...(next !== undefined && { nextCursor: next })
            });
        } else if (r.method === 'skills/get') {
            const uri = (r.params as { uri?: string } | undefined)?.uri;
            const found = pages.flat().find(s => s.uri === uri);
            if (found === undefined) {
                void serverTx.send({ jsonrpc: '2.0', id: r.id, error: { code: -32_602, message: `Unknown skill URI: ${String(uri)}` } });
            } else {
                send({ skill: found, ttlMs: 60_000, cacheScope: 'public' });
            }
        }
    };
    await serverTx.start();

    const client = new Client({ name: 'skills-test-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(clientTx);
    return { client, listParams };
}

describe('capability gating', () => {
    it('reports the advertised extension capability', async () => {
        const { client } = await connectedClient(SKILLS_CAPABLE);
        expect(getSkillsCapability(client)).toEqual({ directoryRead: true });
    });

    it('reports undefined when the server advertises no skills extension', async () => {
        const { client } = await connectedClient({ resources: {} });
        expect(getSkillsCapability(client)).toBeUndefined();
    });

    it('refuses skills/list and skills/get when the extension is not advertised', async () => {
        const { client } = await connectedClient({ resources: {} });
        await expect(listSkills(client)).rejects.toThrow(new RegExp(SKILLS_EXTENSION_ID));
        await expect(getSkill(client, { uri: 'skill://alpha/SKILL.md' })).rejects.toThrow(new RegExp(SKILLS_EXTENSION_ID));
    });

    it('refuses when the extension is advertised without the required resources capability', async () => {
        const { client } = await connectedClient({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
        await expect(listSkills(client)).rejects.toThrow(/does not support resources/);
    });
});

describe('skills/list', () => {
    // typescript-sdk#2789: the era codec validates `resultType` on decode and
    // consumes it, so a result schema must not re-declare it. These calls go
    // through the real decode path against a body that carries it.
    it('parses a spec-conforming resultType:"complete" body (typescript-sdk#2789)', async () => {
        const { client } = await connectedClient(SKILLS_CAPABLE);
        const result = await listSkills(client);
        expect(result.skills.map(s => s.frontmatter.name)).toEqual(['alpha']);
        expect(result.ttlMs).toBe(60_000);
        expect(result.cacheScope).toBe('public');
        expect('resultType' in result).toBe(false);
    });

    it('round-trips a pagination cursor and stops when nextCursor is absent', async () => {
        const { client, listParams } = await connectedClient(SKILLS_CAPABLE, [[skill('alpha')], [skill('beta')]]);

        const first = await listSkills(client);
        expect(first.skills.map(s => s.frontmatter.name)).toEqual(['alpha']);
        expect(first.nextCursor).toBe('1');

        const second = await listSkills(client, { cursor: first.nextCursor });
        expect(second.skills.map(s => s.frontmatter.name)).toEqual(['beta']);
        expect(second.nextCursor).toBeUndefined();

        expect(listParams[1]).toMatchObject({ cursor: '1' });
    });

    it('rejects a server result that violates the skill schema', async () => {
        const bad = [{ ...skill('alpha'), resources: [{ uri: 'skill://alpha/SKILL.md', digest: 'not-a-digest', size: 1 }] }] as Skill[];
        const { client } = await connectedClient(SKILLS_CAPABLE, [bad]);
        await expect(listSkills(client)).rejects.toThrow(/Invalid result for skills\/list/);
    });
});

describe('skills/get', () => {
    it('fetches a skill by its SKILL.md URI', async () => {
        const { client } = await connectedClient(SKILLS_CAPABLE);
        const { skill: found } = await getSkill(client, { uri: 'skill://alpha/SKILL.md' });
        expect(found.frontmatter.description).toBe('The alpha skill.');
    });

    it('surfaces the server -32602 for an unknown skill URI', async () => {
        const { client } = await connectedClient(SKILLS_CAPABLE);
        await expect(getSkill(client, { uri: 'skill://nope/SKILL.md' })).rejects.toThrow(/Unknown skill URI/);
    });
});
