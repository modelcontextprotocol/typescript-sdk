/**
 * End to end through a real `Client` with `SkillsClientExtension` against
 * `McpServer` with `SkillsExtension`, over the stateless `createMcpHandler`.
 * Fixtures are the worked example of the SEP-2640 specification, so the
 * digests and sizes asserted here are the spec's own.
 */
import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClientExtension } from '@modelcontextprotocol/client/ext/skills';
import { describe, expect, it } from 'vitest';

import type { Skill, SkillSource } from '../../../src/ext/skills/index';
import { DIRECTORY_MIME_TYPE, skillResourceOf, SKILLS_EXTENSION_ID, SkillsExtension } from '../../../src/ext/skills/index';
import { CLIENT_CAPABILITIES_META_KEY, createMcpHandler, McpServer, PROTOCOL_VERSION_META_KEY } from '../../../src/index';

const SKILL_URI = 'skill://pdf-processing/SKILL.md';
const FILES: Record<string, string> = {
    [SKILL_URI]:
        '---\nname: pdf-processing\ndescription: Extract, fill, and assemble PDF documents\n---\n\n# PDF processing\n\nChoose the matching template from `templates/`.\n',
    'skill://pdf-processing/templates/invoice.md': '# Invoice\n\nCustomer:\nAmount:\n',
    'skill://pdf-processing/templates/purchase-order.md': '# Purchase order\n\nSupplier:\nItems:\n'
};

const entry = async (): Promise<Skill> => ({
    uri: SKILL_URI,
    frontmatter: { name: 'pdf-processing', description: 'Extract, fill, and assemble PDF documents' },
    resources: await Promise.all(Object.entries(FILES).map(([uri, text]) => skillResourceOf(uri, text)))
});

const UNLISTED: Skill = {
    uri: 'skill://acme/billing/refunds/SKILL.md',
    frontmatter: { name: 'refunds', description: 'Process customer refund requests per company policy' },
    resources: 'dynamic'
};

const directorySource: Required<Pick<SkillSource, 'readDirectory'>> = {
    readDirectory: ({ uri }) =>
        uri === 'skill://pdf-processing/templates'
            ? {
                  resources: [
                      { uri: 'skill://pdf-processing/templates/invoice.md', name: 'invoice.md', mimeType: 'text/markdown' },
                      { uri: 'skill://pdf-processing/templates/regional', name: 'regional', mimeType: DIRECTORY_MIME_TYPE }
                  ]
              }
            : undefined
};

async function createHarness(options?: { source?: Partial<SkillSource>; served?: Record<string, string>; extension?: boolean }) {
    const pdf = await entry();
    const source: SkillSource = {
        list: ({ cursor }) => (cursor === undefined ? { skills: [pdf], nextCursor: 'page-2' } : { skills: [] }),
        get: ({ uri }) => [pdf, UNLISTED].find(skill => skill.uri === uri),
        ...directorySource,
        ...options?.source
    };
    const skills = new SkillsExtension(source, { cacheHint: { ttlMs: 300_000, cacheScope: 'public' } });
    const served = { ...FILES, ...options?.served };
    const createServer = () => {
        const server = new McpServer(
            { name: 'skills-test', version: '1.0.0' },
            { extensions: options?.extension === false ? [] : [skills] }
        );
        for (const [uri, text] of Object.entries(served)) {
            server.registerResource(uri, uri, { mimeType: 'text/markdown' }, () => ({
                contents: [{ uri, mimeType: 'text/markdown', text }]
            }));
        }
        return server;
    };
    const mcpHandler = createMcpHandler(createServer);
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
        fetch: (url, init) => mcpHandler.fetch(new Request(url, init))
    });
    const clientSkills = new SkillsClientExtension();
    const client = new Client({ name: 'harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [clientSkills] });
    await client.connect(transport);
    const raw = async (method: string, params: Record<string, unknown>) => {
        const response = await mcpHandler.fetch(
            new Request('http://test.local/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'MCP-Protocol-Version': '2026-07-28',
                    'Mcp-Method': method
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method,
                    params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} } }
                })
            })
        );
        const text = await response.text();
        const payload = response.headers.get('content-type')?.includes('text/event-stream')
            ? text
                  .split('\n')
                  .filter(line => line.startsWith('data:'))
                  .map(line => line.slice(5).trim())
                  .at(-1)
            : text;
        return JSON.parse(payload ?? '{}') as { result?: Record<string, unknown>; error?: { code: number; message: string } };
    };
    return { client, clientSkills, pdf, raw };
}

describe('SkillsExtension end to end', () => {
    it('declares the extension with directoryRead, alongside resources', async () => {
        const { client } = await createHarness();
        expect(client.getServerCapabilities()?.extensions).toEqual({ [SKILLS_EXTENSION_ID]: { directoryRead: true } });
        expect(client.getServerCapabilities()?.resources).toBeDefined();
    });

    it('lists entries whose digests and sizes are the spec example values', async () => {
        const { clientSkills } = await createHarness();
        const page = await clientSkills.list();
        expect(page).toMatchObject({ nextCursor: 'page-2', ttlMs: 300_000, cacheScope: 'public' });
        expect(page.skills).toEqual([
            {
                uri: SKILL_URI,
                frontmatter: { name: 'pdf-processing', description: 'Extract, fill, and assemble PDF documents' },
                resources: [
                    { uri: SKILL_URI, digest: 'sha256:99b737495721155ece826d57521e2d66141ebdc1344a400487481ea2642ab19e', size: 151 },
                    {
                        uri: 'skill://pdf-processing/templates/invoice.md',
                        digest: 'sha256:61f4ea6d2c75fde1b4977219e7e3107d491c3c26aefb6686e84d6281c088d9ee',
                        size: 29
                    },
                    {
                        uri: 'skill://pdf-processing/templates/purchase-order.md',
                        digest: 'sha256:f2ff774b1737ff3dec81c47946f9976f18a1a9f69dda0a81f22eabd95173c158',
                        size: 35
                    }
                ]
            }
        ]);
        expect((await clientSkills.list({ cursor: 'page-2' })).skills).toEqual([]);
    });

    it('stamps resultType "complete" and the cache fields on the wire', async () => {
        const { raw } = await createHarness();
        const { result } = await raw('skills/get', { uri: SKILL_URI });
        expect(result).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public', skill: { uri: SKILL_URI } });
    });

    it('gets a skill absent from the listing, and answers -32602 for one it does not serve', async () => {
        const { clientSkills } = await createHarness();
        expect((await clientSkills.get(UNLISTED.uri)).skill).toEqual(UNLISTED);
        await expect(clientSkills.get('skill://acme/billing/chargebacks/SKILL.md')).rejects.toMatchObject({
            code: -32602,
            message: expect.stringContaining('No skill is served at skill://acme/billing/chargebacks/SKILL.md')
        });
    });

    it('answers -32603 when the source returns an entry that breaks the structural rules', async () => {
        const { clientSkills, pdf } = await createHarness({
            source: { get: () => ({ ...pdf, frontmatter: { name: 'renamed', description: 'mismatch' } }) }
        });
        await expect(clientSkills.get(SKILL_URI)).rejects.toMatchObject({ code: -32603 });
    });

    it('reads a directory, and answers -32602 for a URI that is not one', async () => {
        const { clientSkills } = await createHarness();
        const listing = await clientSkills.readDirectory('skill://pdf-processing/templates');
        expect(listing.resources.map(resource => [resource.name, resource.mimeType])).toEqual([
            ['invoice.md', 'text/markdown'],
            ['regional', DIRECTORY_MIME_TYPE]
        ]);
        await expect(clientSkills.readDirectory(SKILL_URI)).rejects.toMatchObject({ code: -32602 });
    });

    it('reads a listed file verified against the entry', async () => {
        const { clientSkills, pdf } = await createHarness();
        const content = await clientSkills.read(pdf, 'skill://pdf-processing/templates/invoice.md');
        expect(content).toMatchObject({ text: '# Invoice\n\nCustomer:\nAmount:\n' });
    });

    it('refuses a file whose bytes differ from the entry, and a file the entry does not list', async () => {
        const { clientSkills, pdf } = await createHarness({
            served: {
                'skill://pdf-processing/templates/invoice.md': '# Invoice\n\nCustomer:\nAmount: 0\n',
                'skill://pdf-processing/templates/credit-note.md': '# Credit note\n'
            }
        });
        const invalid = { name: 'SdkError', code: SdkErrorCode.InvalidResult };
        await expect(clientSkills.read(pdf, 'skill://pdf-processing/templates/invoice.md')).rejects.toMatchObject(invalid);
        await expect(clientSkills.read(pdf, 'skill://pdf-processing/templates/credit-note.md')).rejects.toMatchObject(invalid);
    });

    it('refuses directory reads when the server did not declare directoryRead', async () => {
        const { clientSkills } = await createHarness({ source: { readDirectory: undefined } });
        await expect(clientSkills.readDirectory('skill://pdf-processing/templates')).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.CapabilityNotSupported
        );
    });

    it('refuses skills requests to a server that did not declare the extension', async () => {
        const { clientSkills } = await createHarness({ extension: false });
        await expect(clientSkills.list()).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.CapabilityNotSupported
        );
    });
});
