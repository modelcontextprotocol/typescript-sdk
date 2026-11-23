# Serve skills from an MCP server

<!-- #region guide -->

`loadSkills` reads a folder of skills once; `attach` serves it on a server.

```ts source="../../../examples/guides/servers/skills.examples.ts#loadSkills_basic"
import { McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

const skills = await loadSkills('./skills');

const server = new McpServer({ name: 'team-skills', version: '1.0.0' });
skills.attach(server);
```

`attach` is experimental: how an extension is wired to a server may change in a minor release.

A **skill** is a folder with a `SKILL.md` and the files it references (SEP-2640). Clients list skills with `skills/list` and read each file with `resources/read`, checking it against the digest your server published.

## Lay out the skills folder

Each folder that contains a `SKILL.md` is one skill; other folders only group skills in the URI.

```text
skills/
├── git-workflow/
│   ├── SKILL.md
│   └── references/REVIEW.md
└── acme/billing/refunds/
    └── SKILL.md
```

`SKILL.md` starts with YAML frontmatter holding `name` (the same as the skill's folder name) and `description`. Print the URIs the catalog publishes:

```ts source="../../../examples/guides/servers/skills.examples.ts#entries"
console.log(skills.entries.map(skill => skill.uri).join('\n'));
```

It prints one `SKILL.md` URI per skill, sorted:

```text
skill://acme/billing/refunds/SKILL.md
skill://git-workflow/SKILL.md
```

## Serve one catalog from every server

Attach the same catalog to each server your handler creates.

```ts source="../../../examples/guides/servers/skills.examples.ts#attach_perRequest"
import { createMcpHandler } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'team-skills', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
});
```

The catalog keeps metadata only (paths, digests, sizes, frontmatter); each read goes to the folder, and the SDK serves the bytes only if they still match the published digest. It sends a file as `text` whenever its bytes are valid UTF-8 (a BOM included), whatever its MIME type, and as a base64 `blob` otherwise.

## Pick up changes with `reload()`

Rescan the folder and swap the new catalog in at once.

```ts source="../../../examples/guides/servers/skills.examples.ts#reload"
const changes = await skills.reload();
console.log(changes);
```

With nothing changed on disk, `reload()` reports no changes:

```text
{ added: [], removed: [], changed: [], listChanged: false }
```

Until you call `reload()`, the server answers a read of a file edited on disk with an error instead of unverified content. If the rescan fails, `reload()` rejects and the old catalog keeps serving.

`listChanged` is `true` when a skill appears, disappears, or changes its name or description. A server that stays connected (on stdio, or in a stateful 2025-11-25 HTTP session) then sends its clients `notifications/resources/list_changed` itself. A server that `createMcpHandler` builds lives for one request, so publish the change on the handler instead:

```ts source="../../../examples/guides/servers/skills.examples.ts#reload_notify"
if (changes.listChanged) handler.notify.resourcesChanged();
```

Every open `subscriptions/listen` stream that opted in to resource list changes receives the notification.

## Serve skills defined in code

Pass the files to `memorySkillFiles` where there is no file system, such as Workers or tests.

```ts source="../../../examples/guides/servers/skills.examples.ts#memorySkillFiles"
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const RELEASE_NOTES_MD = `---
name: release-notes
description: Write release notes from merged pull requests.
---
# Release notes
`;

const inline = await SkillsExtension.load(memorySkillFiles({ 'release-notes/SKILL.md': RELEASE_NOTES_MD }));
```

`memorySkillFiles` re-reads the object you pass whenever the catalog rescans (at load and on `reload()`), so `reload()` sees files you add or change later.

## Serve skills from your own storage

Implement `SkillFiles`, two functions over relative paths, to load from any store.

```ts source="../../../examples/guides/servers/skills.examples.ts#skillFiles_custom"
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
```

The catalog logic (discovery, digests, rule checks, paging, verified reads) is the same for every adapter. Report a symlink or other special file as `kind: 'unsupported'`; the catalog skips the skill that contains one.

## Generate skills with a `SkillSource`

Build entries with `skillEntry` and serve them from a `SkillSource` when the catalog depends on the request.

```ts source="../../../examples/guides/servers/skills.examples.ts#skillSource"
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
```

Every source method receives the request context (`ctx`), so you can list different skills per caller. Add `readDirectory` to serve folder listings, and `listResources` to list skills in `resources/list`.

## Handle invalid skills

Route warnings where you want them; by default they go to stderr.

```ts source="../../../examples/guides/servers/skills.examples.ts#onWarning"
const checked = await loadSkills('./skills', {
    onWarning: ({ path, message }) => console.error(`skills: ${path}: ${message}`)
});
```

`loadSkills` skips, with a warning, any skill that breaks the rules, such as a `name` that differs from its folder or a symlinked file; the other skills still serve. Skills over 512 files or 16 MiB still publish, with a warning; `limits` changes those thresholds. The same options take `prefix` (`'acme'` serves every skill under `skill://acme/…`) and `pageSize` (entries per `skills/list` and directory page, default 100).

Set `strict: true` to make `loadSkills` throw a `SkillCatalogError` listing every problem instead. Under `strict: true`, a symlink or other special file anywhere in the folder fails the load, even one outside every skill; hidden entries (names starting with `.`) are the exception, since the scan skips them entirely.

::: warning
Do not register your own resources under `skill://`. A resource you register at a skill file's URI takes precedence over that file, and clients then fail to verify it.
:::

::: info
Skills work on both protocol versions; the `cacheHint` option applies on 2026-07-28 only — see [Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.md).
:::

## Recap

- `loadSkills('./skills')` builds a catalog once; `attach(server)` serves it on any number of servers.
- Each folder with a `SKILL.md` is a skill; other folders group skills in the URI.
- `reload()` swaps in a rescanned catalog all at once; behind `createMcpHandler`, call `handler.notify.resourcesChanged()` when it reports `listChanged`.
- `memorySkillFiles`, a `SkillFiles` adapter or a `SkillSource` serve skills without a folder.
- `loadSkills` skips invalid skills with a warning; `strict: true` makes it throw instead.

<!-- #endregion guide -->
