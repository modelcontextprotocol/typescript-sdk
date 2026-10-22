/**
 * Companion example for `skills/mcp-typescript-sdk-skills/references/server.md`,
 * which renders as `docs/servers/skills.md`.
 *
 * Every `ts` fence in that file is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs (`pnpm docs:examples`)
 * and prints the output the page quotes.
 *
 *     npx tsx guides/servers/skills.examples.ts    # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The page loads `./skills`; run from this file's folder so that path resolves.
process.chdir(path.dirname(fileURLToPath(import.meta.url)));

//#region loadSkills_basic
import { McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

const skills = await loadSkills('./skills');

const server = new McpServer({ name: 'team-skills', version: '1.0.0' });
skills.attach(server);
//#endregion loadSkills_basic

//#region entries
console.log(skills.entries.map(skill => skill.uri).join('\n'));
//#endregion entries

//#region attach_perRequest
import { createMcpHandler } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'team-skills', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
});
//#endregion attach_perRequest

// What the handler publishes to `subscriptions/listen` streams, recorded for the checks at the end.
const published: string[] = [];
handler.bus.subscribe(event => published.push(event.kind));

//#region reload
const changes = await skills.reload();
console.log(changes);
//#endregion reload

//#region reload_notify
if (changes.listChanged) handler.notify.resourcesChanged();
//#endregion reload_notify

//#region memorySkillFiles
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const RELEASE_NOTES_MD = `---
name: release-notes
description: Write release notes from merged pull requests.
---
# Release notes
`;

const inline = await SkillsExtension.load(memorySkillFiles({ 'release-notes/SKILL.md': RELEASE_NOTES_MD }));
//#endregion memorySkillFiles

//#region skillFiles_custom
import type { SkillFiles } from '@modelcontextprotocol/server/ext/skills';

// Two operations over '/'-separated paths, '' being the root: here, a key-value store of objects.
function bucketSkillFiles(bucket: ReadonlyMap<string, Uint8Array>): SkillFiles {
    return {
        async list(dir) {
            const prefix = dir === '' ? '' : `${dir}/`;
            const children = new Map<string, 'file' | 'directory'>();
            for (const key of bucket.keys()) {
                if (!key.startsWith(prefix)) continue;
                const [name, ...rest] = key.slice(prefix.length).split('/');
                if (name !== undefined) children.set(name, rest.length > 0 ? 'directory' : 'file');
            }
            return [...children].map(([name, kind]) => ({ name, kind }));
        },
        async read(key) {
            const bytes = bucket.get(key);
            if (bytes === undefined) throw new Error(`no object ${key}`);
            return bytes;
        }
    };
}

const fromBucket = await SkillsExtension.load(
    bucketSkillFiles(new Map([['release-notes/SKILL.md', new TextEncoder().encode(RELEASE_NOTES_MD)]]))
);
//#endregion skillFiles_custom

//#region skillSource
import type { SkillSource } from '@modelcontextprotocol/server/ext/skills';
import { skillEntry } from '@modelcontextprotocol/server/ext/skills';

const ON_CALL_MD = `---
name: on-call
description: Handle a page while on call.
---
# On call
`;
const onCall = await skillEntry('on-call', { 'SKILL.md': ON_CALL_MD });

const source: SkillSource = {
    list: async () => ({ skills: [onCall] }),
    get: async uri => (uri === onCall.uri ? onCall : undefined),
    read: async uri => (uri === onCall.uri ? { text: ON_CALL_MD, mimeType: 'text/markdown' } : undefined)
};
const generated = new SkillsExtension({ source });
//#endregion skillSource

//#region onWarning
const checked = await loadSkills('./skills', {
    onWarning: ({ path, message }) => console.error(`skills: ${path}: ${message}`)
});
//#endregion onWarning

//#region verify_inMemory
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'skills-check', version: '1.0.0' });
await client.connect(clientTransport);

const skillsClient = new SkillsClient(client);
const { skills: listed } = await skillsClient.list();
if (listed.length === 0) throw new Error('the server listed no skills');
for (const entry of listed) {
    const files = entry.resources === 'dynamic' ? [entry.uri] : entry.resources.map(file => file.uri);
    for (const uri of files) await skillsClient.read(entry, uri);
}
console.log(`${listed.length} skill(s) listed and verified`);
//#endregion verify_inMemory

// Claims the page makes, checked on every run.
const QUOTED_URIS = ['skill://acme/billing/refunds/SKILL.md', 'skill://git-workflow/SKILL.md'];
if (JSON.stringify(skills.entries.map(skill => skill.uri)) !== JSON.stringify(QUOTED_URIS)) {
    throw new Error('skills.md: the catalog must publish the quoted URIs, sorted');
}
if (checked.entries.length !== 2) throw new Error('skills.md: expected two skills');
if (listed.length !== 2) throw new Error('SKILL.md: the in-memory check must list and verify both skills');
if (JSON.stringify(changes) !== JSON.stringify({ added: [], removed: [], changed: [], listChanged: false })) {
    throw new Error('skills.md: reload claim failed');
}
// reload_notify: nothing changed, so nothing was published; a skill appearing is a listing change the handler publishes.
if (published.length > 0) throw new Error('skills.md: an unchanged reload must not publish');
const record: Record<string, string> = { 'release-notes/SKILL.md': RELEASE_NOTES_MD };
const live = await SkillsExtension.load(memorySkillFiles(record));
record['on-call/SKILL.md'] = ON_CALL_MD;
const liveChanges = await live.reload();
if (liveChanges.listChanged) handler.notify.resourcesChanged();
if (!liveChanges.listChanged || JSON.stringify(published) !== JSON.stringify(['resources_list_changed'])) {
    throw new Error('skills.md: a skill added must set listChanged, and handler.notify must publish resources/list_changed');
}
if (inline.entries[0]?.frontmatter.name !== 'release-notes' || fromBucket.entries[0]?.uri !== inline.entries[0]?.uri) {
    throw new Error('skills.md: in-code and adapter catalogs must match');
}
for (const extension of [inline, fromBucket, generated]) extension.attach(new McpServer({ name: 'docs-check', version: '1.0.0' }));
await handler.close();
await server.close();
