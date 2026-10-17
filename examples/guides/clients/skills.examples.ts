/**
 * Companion example for `docs/clients/skills.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs (`pnpm docs:examples`)
 * against an in-memory server and prints the output the page quotes.
 *
 *     npx tsx guides/clients/skills.examples.ts    # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const catalog = await SkillsExtension.load(
    memorySkillFiles({
        'git-workflow/SKILL.md':
            '---\nname: git-workflow\ndescription: Branching and review conventions.\n---\n# Git workflow\n\nGo through references/REVIEW.md.\n',
        'git-workflow/references/REVIEW.md': '# Review checklist\n\n- Tests pass.\n',
        'acme/billing/refunds/SKILL.md': '---\nname: refunds\ndescription: Process customer refunds.\n---\n# Refunds\n',
        'acme/billing/refunds/templates/refund-email.md': 'Your refund is on its way.\n'
    })
);
const server = new McpServer({ name: 'team-skills', version: '1.0.0' });
catalog.attach(server);
const client = new Client({ name: 'skills-docs-host', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

//#region SkillsClient_list
import { SkillsClient, SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';

const skills = new SkillsClient(client);
const { skills: entries } = await skills.list();
console.log(entries.map(entry => `${entry.frontmatter.name}: ${entry.frontmatter.description}`).join('\n'));
//#endregion SkillsClient_list

//#region read_manifest
const git = entries.find(entry => entry.frontmatter.name === 'git-workflow')!;
const manifest = await skills.read(git);
console.log(manifest.verified, manifest.frontmatter);
//#endregion read_manifest

//#region read_reference
const review = await skills.read(git, 'references/REVIEW.md');
console.log(review.text);
//#endregion read_reference

//#region SkillVerificationError
try {
    await skills.read(git, 'references/MISSING.md');
} catch (error) {
    if (!(error instanceof SkillVerificationError)) throw error;
    console.log(error.reason, error.uri);
}
//#endregion SkillVerificationError

//#region readDirectory
if (skills.directoryRead) {
    const children = await skills.readDirectory('skill://acme/billing/refunds');
    console.log(children.map(child => `${child.name} ${child.mimeType}`).join('\n'));
}
//#endregion readDirectory

//#region get
const refunds = await skills.get('skill://acme/billing/refunds/SKILL.md');
console.log(refunds.frontmatter.name);
//#endregion get

// Claims the page makes, checked on every run.
if (!manifest.verified || manifest.body === undefined || review.text !== '# Review checklist\n\n- Tests pass.\n') {
    throw new Error('clients/skills.md: read claims failed');
}
await client.close();
await server.close();
