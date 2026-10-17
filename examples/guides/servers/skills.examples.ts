/**
 * Companion example for `docs/servers/skills.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
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
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

const skills = await loadSkills('./skills');

const server = new McpServer({ name: 'team-skills', version: '1.0.0' });
skills.attach(server);
//#endregion loadSkills_basic

//#region entries
console.log(skills.entries.map(skill => skill.uri).join('\n'));
//#endregion entries

//#region attach_perRequest
const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'team-skills', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
});
//#endregion attach_perRequest

//#region reload
const changes = await skills.reload();
console.log(changes);
//#endregion reload

//#region memorySkillFiles
import type { SkillFiles, SkillSource } from '@modelcontextprotocol/server/ext/skills';
import { memorySkillFiles, skillEntry, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const RELEASE_NOTES_MD = '---\nname: release-notes\ndescription: Write release notes from merged pull requests.\n---\n# Release notes\n';

const inline = await SkillsExtension.load(memorySkillFiles({ 'release-notes/SKILL.md': RELEASE_NOTES_MD }));
//#endregion memorySkillFiles

//#region skillFiles_custom
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
const ON_CALL_MD = '---\nname: on-call\ndescription: Handle a page while on call.\n---\n# On call\n';
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

// Claims the page makes, checked on every run.
if (skills.entries.length !== 2 || checked.entries.length !== 2) throw new Error('skills.md: expected two skills');
if (JSON.stringify(changes) !== JSON.stringify({ added: [], removed: [], changed: [] })) throw new Error('skills.md: reload claim failed');
if (inline.entries[0]?.frontmatter.name !== 'release-notes' || fromBucket.entries[0]?.uri !== inline.entries[0]?.uri) {
    throw new Error('skills.md: in-code and adapter catalogs must match');
}
for (const extension of [inline, fromBucket, generated]) extension.attach(new McpServer({ name: 'docs-check', version: '1.0.0' }));
void handler;
await server.close();
