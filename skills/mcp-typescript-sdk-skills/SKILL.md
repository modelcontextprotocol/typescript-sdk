---
name: mcp-typescript-sdk-skills
description: 'Serves and consumes Skills over MCP (SEP-2640, the `io.modelcontextprotocol/skills` extension) with v2 of the MCP TypeScript SDK: publishes a folder of `SKILL.md` skills from an MCP server with `loadSkills` and `SkillsExtension`, and lists, verifies and loads them in a client or host with `SkillsClient`. Use whenever a TypeScript project on `@modelcontextprotocol/server` or `@modelcontextprotocol/client` 2.x wants to expose agent skills from its MCP server, serve `skill://` resources or `skills/list`, or load skills from the MCP servers it connects to, even if the user does not say "SEP-2640" or "extension". Not for projects still on v1 (`@modelcontextprotocol/sdk`: upgrade them with the `mcp-typescript-sdk-upgrade-to-v2` skill first), for MCP SDKs in other languages (Python, Go, C#), or for writing the content of a `SKILL.md`.'
---

# Skills over MCP with the TypeScript SDK

Skills over MCP lets an MCP server publish agent skills (folders with a `SKILL.md`) and lets clients list, verify and load them. In v2 of the TypeScript SDK it ships as the `ext/skills` subpaths of `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.

The goal is working, verified code in the user's project. Use only the APIs shown here and in the references, and skip explaining the protocol unless the user asks.

## Which side the project is on

Read `package.json` and the source before writing anything:

- **Server:** depends on `@modelcontextprotocol/server` and creates an `McpServer`, directly or in a factory passed to `serveStdio` or `createMcpHandler`. It publishes skills: follow [Serve skills](#serve-skills).
- **Client or host:** depends on `@modelcontextprotocol/client` and creates a `Client`. It loads skills from the servers it connects to: follow [Use skills](#use-skills).
- **Both** (a host that also runs a server, a gateway): follow both, each against its own code. A `Client` that exists only in the project's tests does not make it a host: that is where [Verify](#verify) runs.
- **v1** (`@modelcontextprotocol/sdk`): Skills over MCP exists only in v2. Upgrade first with the `mcp-typescript-sdk-upgrade-to-v2` skill, then come back.

## Check that the installed SDK has skills

Skills over MCP ships in the `./ext/skills` export of the v2 packages, and an import of a subpath the installed package lacks fails only at build or run time. Check first, from the package that depends on the SDK (use `client` in place of `server` for a client):

```bash
grep -c '"./ext/skills"' node_modules/@modelcontextprotocol/server/package.json
```

If it prints `0`, check the latest release:

```bash
npm view @modelcontextprotocol/server@latest exports --json | grep -c '"./ext/skills"'
```

- **The latest release has it:** upgrade (`server` and `client` to the same version, if the project uses both) and continue.
- **It does not:** stop here. Tell the user that Skills over MCP is not in a released version of the SDK yet, and that this works once a release exports `@modelcontextprotocol/server/ext/skills`. Do not write `skills/list` handlers or `skill://` resources by hand as a workaround. Clients verify every file against the digests and frontmatter the extension publishes, and the extension also declares the capability, pages the catalog and handles both protocol versions, so a hand-written copy is easy to get wrong in ways those clients refuse, and drifts from the spec.

## Serve skills

**Pick where the skills come from.** Each source gives you an extension that you attach as shown below; only the first three have `reload()`:

- **A folder on disk** (Node): `loadSkills`, which the steps below walk through.
- **Skills defined in code** (Workers and other runtimes without a file system, tests): `memorySkillFiles`. See [Serve skills defined in code](references/server.md#serve-skills-defined-in-code).
- **Your own storage** (an object store, a database, a git repository): a `SkillFiles` adapter. See [Serve skills from your own storage](references/server.md#serve-skills-from-your-own-storage).
- **Skills that differ per caller or are generated per request:** a `SkillSource`. See [Generate skills with a `SkillSource`](references/server.md#generate-skills-with-a-skillsource).

**Lay out the folder.** Each folder holding a `SKILL.md` is one skill. Its frontmatter needs a `name` equal to the folder's name and a `description`. Other folders only group skills in the URI.

**Load the folder once and attach it before the server connects.** `attach` throws on a connected server, and each server takes one skills extension. A server connected by hand keeps its `server.connect(transport)` call, after `attach`.

```ts source="../../examples/guides/servers/skills.examples.ts#loadSkills_basic"
import { McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';

const skills = await loadSkills('./skills');

const server = new McpServer({ name: 'team-skills', version: '1.0.0' });
skills.attach(server);
```

**Resolve the folder from the module, not the working directory.** A relative path like `'./skills'` resolves against `process.cwd()`, and MCP hosts may start stdio servers from another directory (such as `/`), where the load throws and takes the whole server down with it. Build the path from the module's location instead: `fileURLToPath(new URL('../skills', import.meta.url))` from `src/index.ts`, or `path.join(__dirname, '../skills')` in CommonJS.

**Where a factory builds the server, attach inside it**, so every server it builds serves the same catalog. That covers `serveStdio(createServer)` on stdio as well as `createMcpHandler` over HTTP:

```ts source="../../examples/guides/servers/skills.examples.ts#attach_perRequest"
import { createMcpHandler } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'team-skills', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
});
```

**Pick up edits with `reload()`** if the user expects changes to show without a restart. Call it from whatever tells the project the folder changed (a file watcher, an admin route, a deploy hook). A server that stays connected (stdio) notifies its clients itself. Behind `createMcpHandler`, publish the change on the handler, where `changes` is what `await skills.reload()` returned:

```ts source="../../examples/guides/servers/skills.examples.ts#reload_notify"
if (changes.listChanged) handler.notify.resourcesChanged();
```

Then tell the user about any load warnings, and [verify](#verify).

Read [references/server.md](references/server.md) for `onWarning`, `strict`, `limits`, `prefix` and `pageSize`.

## Use skills

**Wrap the connected client and list.** Listing reads no skill file: each entry carries the skill's frontmatter and file list, enough to show what is on offer.

```ts source="../../examples/guides/clients/skills.examples.ts#SkillsClient_list"
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';

const skills = new SkillsClient(client);
const { skills: entries } = await skills.list();
console.log(entries.map(entry => `${entry.frontmatter.name}: ${entry.frontmatter.description}`).join('\n'));
```

`skills.supported` is `false` for a server that does not declare the extension; a host that connects to several servers checks it per server before listing. `list()` throws an `SdkError` if any entry is invalid, so a host listing servers it does not control creates the client with `new SkillsClient(client, { skipInvalid: true })` and logs the refused entries it returns in `invalid`.

**Load a skill only after the user (or the host's policy) approves it.** Read its `SKILL.md`, which checks size, digest and frontmatter, and give `manifest.body` to the model:

```ts source="../../examples/guides/clients/skills.examples.ts#read_manifest"
const git = entries.find(entry => entry.frontmatter.name === 'git-workflow')!;
const manifest = await skills.read(git);
console.log(manifest.verified, manifest.frontmatter);
```

Read the files `SKILL.md` refers to with `skills.read(entry, path)` when the model needs them. A failed check throws `SkillVerificationError`: do not use that file, and if it is the `SKILL.md`, do not load the skill.

Read [references/client.md](references/client.md) for `skipInvalid`, verification reasons, `readDirectory`, `get`, dynamic skills and caching hints.

## Mistakes to avoid

Serving:

- **Writing the protocol by hand.** Serve skills only through `SkillsExtension` (`loadSkills`, `memorySkillFiles`, a `SkillFiles` adapter or a `SkillSource`). Never `setRequestHandler('skills/list', …)`, and never register your own resources under `skill://`: a resource at a skill file's URI takes precedence over the file, and clients then fail to verify it.
- **Missing the skipped skills.** `loadSkills` skips a skill whose `name` differs from its folder, or that contains a symlink, and only warns (on stderr by default) while the others serve. Read the warnings after loading and tell the user which skills were skipped. Pass `strict: true` (in CI, say) to make the load throw instead.
- **Dot-named entries.** Files and folders whose names start with `.` are skipped with no warning at all, and `strict: true` does not catch them. A skill in a `.name` folder, or a dotfile its `SKILL.md` refers to, is simply missing: rename it.
- **A catalog outside the factory's servers.** `serveStdio` and `createMcpHandler` build their servers from a factory, and each server `createMcpHandler` builds lives for one request. Attach inside the factory, and behind `createMcpHandler` call `handler.notify.resourcesChanged()` when `reload()` reports `listChanged`, or connected clients never hear of the change.
- **Expecting edits to show up on their own.** The catalog keeps the digests from load time, so a file edited on disk afterwards is refused with an error until `reload()` runs.
- **`loadSkills` without a file system.** It reads the disk (`ext/skills/node`). On Workers and similar runtimes, use `memorySkillFiles` or a `SkillFiles` adapter from `@modelcontextprotocol/server/ext/skills`.

Loading:

- **Raw `resources/read`.** Never fetch skill files with `client.readResource()`: it skips the size, digest and frontmatter checks. Use `skills.read()`.
- **Reading while listing.** Read a skill's files when it is loaded, never while listing.
- **Skipping the host's duties.** Accept skills up to `SKILL_LIMITS` (512 files, 16 MiB) and explain why you decline one, get approval before loading a skill from a server, and record which server each skill came from, so the instructions given to the model can be traced to their source.

Both:

- **Invented APIs.** Take skills APIs only from `@modelcontextprotocol/server/ext/skills`, `@modelcontextprotocol/server/ext/skills/node` and `@modelcontextprotocol/client/ext/skills`, using names shown here or in the references. If you need something else, read the package's type declarations instead of guessing.

## Verify

**Server:** list every skill and read every file it lists through a real client. In a script or test, connect a `Client` to the server over an in-memory pair and read each file with `SkillsClient`. `read` throws when a file fails a check, and the loop throws when the server lists no skills:

```ts source="../../examples/guides/servers/skills.examples.ts#verify_inMemory"
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
```

An entry whose `resources` is `"dynamic"` (only a `SkillSource` serves one) has no file list, so the loop reads only its `SKILL.md`: `read` checks the frontmatter but has no size or digest to check, and returns `verified: false`.

For a stdio server, the same loop works over `StdioClientTransport` (from `@modelcontextprotocol/client/stdio`) against the server's real start command; set its `cwd` option to another directory (such as `/`), as hosts do, so a path that depends on the working directory fails here and not in the user's host. Compare the number of skills listed with the number of skill folders, and account for each one missing: a warning, or a dot-name.

**Client:** run the host against a server that serves at least one skill (the server path above takes a few lines, or `memorySkillFiles` in a test). Check that it lists the skill, asks before loading it, and reads its `SKILL.md` with `verified: true`.

## References

| Reference file                                          | Read it when                                  |
| ------------------------------------------------------- | --------------------------------------------- |
| [Serve skills from an MCP server](references/server.md) | The project serves skills from an MCP server  |
| [Use skills from MCP servers](references/client.md)     | The project loads skills from its MCP servers |
