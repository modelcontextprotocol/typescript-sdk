/**
 * Companion example for `skills/mcp-typescript-sdk-skills/references/client.md`,
 * which renders as `docs/clients/skills.md`.
 *
 * Every `ts` fence in that file is synced from a `//#region` in this file
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
        'git-workflow/SKILL.md': `---
name: git-workflow
description: Branching and review conventions.
---
# Git workflow

Go through references/REVIEW.md.
`,
        'git-workflow/references/REVIEW.md': `# Review checklist

- Tests pass.
`,
        'acme/billing/refunds/SKILL.md': `---
name: refunds
description: Process customer refunds.
---
# Refunds
`,
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
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';

const skills = new SkillsClient(client);
const { skills: entries } = await skills.list();
console.log(entries.map(entry => `${entry.frontmatter.name}: ${entry.frontmatter.description}`).join('\n'));
//#endregion SkillsClient_list

//#region list_invalid
const tolerant = new SkillsClient(client, { skipInvalid: true });
const { invalid } = await tolerant.list();
for (const refused of invalid) console.error(`skills: refused entry #${refused.index} ${refused.uri ?? ''}: ${refused.reason}`);
//#endregion list_invalid

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
import { SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';

try {
    await skills.read(git, 'references/MISSING.md');
} catch (error) {
    if (!(error instanceof SkillVerificationError)) throw error;
    console.log(error.reason, error.uri);
}
//#endregion SkillVerificationError

//#region readDirectory
if (skills.directoryRead) {
    const { resources: children } = await skills.readDirectory('skill://acme/billing/refunds');
    console.log(children.map(child => `${child.name} ${child.mimeType}`).join('\n'));
}
//#endregion readDirectory

//#region get
const { skill: refunds } = await skills.get('skill://acme/billing/refunds/SKILL.md');
console.log(refunds.frontmatter.name);
//#endregion get

// Claims the page makes, checked on every run.
const claim = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`clients/skills.md: ${what}`);
};
const listed = entries.map(entry => `${entry.frontmatter.name}: ${entry.frontmatter.description}`);
claim(
    JSON.stringify(listed) === JSON.stringify(['refunds: Process customer refunds.', 'git-workflow: Branching and review conventions.']),
    'list() must return the quoted entries, in order'
);
claim(invalid.length === 0, 'invalid must be empty against this server');
claim(
    manifest.verified &&
        manifest.body !== undefined &&
        JSON.stringify(manifest.frontmatter) === JSON.stringify({ name: 'git-workflow', description: 'Branching and review conventions.' }),
    'read(entry) must verify SKILL.md and return its frontmatter and body'
);
claim(review.text === '# Review checklist\n\n- Tests pass.\n', 'read(entry, path) must return the quoted file text');
let missing: unknown;
try {
    await skills.read(git, 'references/MISSING.md');
} catch (error) {
    missing = error;
}
claim(
    missing instanceof SkillVerificationError &&
        missing.reason === 'unlisted' &&
        missing.uri === 'skill://git-workflow/references/MISSING.md',
    'an unlisted path must throw SkillVerificationError(unlisted) with the quoted URI'
);
claim(skills.directoryRead, 'the server must declare directoryRead');
const { resources: refundsFolder } = await skills.readDirectory('skill://acme/billing/refunds');
claim(
    JSON.stringify(refundsFolder.map(child => `${child.name} ${child.mimeType}`)) ===
        JSON.stringify(['SKILL.md text/markdown', 'templates inode/directory']),
    'the refunds folder must list the quoted children'
);
claim(refunds.frontmatter.name === 'refunds', 'get() must return the refunds entry');
await client.close();
await server.close();
