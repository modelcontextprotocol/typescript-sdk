# Use skills from MCP servers

<!-- #region guide -->

`SkillsClient` lists a server's skills and reads their files, checking each file against what the server published.

```ts source="../../../examples/guides/clients/skills.examples.ts#SkillsClient_list"
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';

const skills = new SkillsClient(client);
const { skills: entries } = await skills.list();
console.log(entries.map(entry => `${entry.frontmatter.name}: ${entry.frontmatter.description}`).join('\n'));
```

Against a server with two skills, it prints each skill's name and description:

```text
refunds: Process customer refunds.
git-workflow: Branching and review conventions.
```

Listing reads no skill file: each **entry** carries the skill's frontmatter and its file list with digests, enough to decide which skill to load.

## Handle refused entries

Create the client with `skipInvalid: true` to keep the valid skills and log the refused entries.

```ts source="../../../examples/guides/clients/skills.examples.ts#list_invalid"
const tolerant = new SkillsClient(client, { skipInvalid: true });
const { invalid } = await tolerant.list();
for (const refused of invalid) console.error(`skills: refused entry #${refused.index} ${refused.uri ?? ''}: ${refused.reason}`);
```

By default `list()` throws an `SdkError` naming every entry that fails validation, and every copy of a repeated URI. With `skipInvalid: true` it returns the valid skills and puts those entries in `invalid`, each with `index`, `uri` when it has one, and `reason`. Against this server it is empty, so the loop prints nothing.

## Load a skill

Read the entry's `SKILL.md`.

```ts source="../../../examples/guides/clients/skills.examples.ts#read_manifest"
const git = entries.find(entry => entry.frontmatter.name === 'git-workflow')!;
const manifest = await skills.read(git);
console.log(manifest.verified, manifest.frontmatter);
```

The file passes every check, and its frontmatter matches the entry:

```text
true {
  name: 'git-workflow',
  description: 'Branching and review conventions.'
}
```

`read(entry)` checks the size and SHA-256 digest against the entry, then compares the frontmatter field by field. `manifest.body` holds the instructions to give the model.

The comparison parses the frontmatter with YAML 1.2 core-schema typing, so `yes` is the string `"yes"`, not `true`. If a server builds its entries with a parser that types values differently, pass a matching YAML parser as `parseFrontmatter` to `new SkillsClient`; it receives the YAML between the `---` lines.

## Read the files a skill references

Pass the path `SKILL.md` uses.

```ts source="../../../examples/guides/clients/skills.examples.ts#read_reference"
const review = await skills.read(git, 'references/REVIEW.md');
console.log(review.text);
```

`review.text` holds the verified file:

```text
# Review checklist

- Tests pass.

```

A relative path resolves against the skill's folder, as a link in `SKILL.md` does, and `read` ignores a fragment. It matches the path to the entry's file list however either side percent-encodes the name, so `references/Q&A.md` works. `bytes` always holds the file's bytes; `text` holds the file's text when the server sent it as text, and always for the skill's own `SKILL.md`.

## Handle verification failures

Catch `SkillVerificationError`.

```ts source="../../../examples/guides/clients/skills.examples.ts#SkillVerificationError"
import { SkillVerificationError } from '@modelcontextprotocol/client/ext/skills';

try {
    await skills.read(git, 'references/MISSING.md');
} catch (error) {
    if (!(error instanceof SkillVerificationError)) throw error;
    console.log(error.reason, error.uri);
}
```

The entry does not list `references/MISSING.md`, so `read` refuses it before sending any request:

```text
unlisted skill://git-workflow/references/MISSING.md
```

`reason` is `unlisted`, `size`, `digest` or `frontmatter`; a path that does not parse is `unlisted` too. When a size, digest or frontmatter check fails on a copy the client served from its response cache, `read` fetches the file once more with `cacheMode: 'refresh'` and throws only if the fresh copy fails as well; a copy that came from the server fails at once. On any reason, do not use the file; for `SKILL.md`, do not load the skill.

## Browse a skill folder

List a folder's direct children when the server declares `directoryRead`.

```ts source="../../../examples/guides/clients/skills.examples.ts#readDirectory"
if (skills.directoryRead) {
    const { resources: children } = await skills.readDirectory('skill://acme/billing/refunds');
    console.log(children.map(child => `${child.name} ${child.mimeType}`).join('\n'));
}
```

The `refunds` folder holds its `SKILL.md` and a `templates` folder:

```text
SKILL.md text/markdown
templates inode/directory
```

## Get a skill by URI

Fetch one entry, listed or not.

```ts source="../../../examples/guides/clients/skills.examples.ts#get"
const { skill: refunds } = await skills.get('skill://acme/billing/refunds/SKILL.md');
console.log(refunds.frontmatter.name);
```

It prints the skill's name from the entry's frontmatter:

```text
refunds
```

On 2026-07-28, `list()`, `get()` and `readDirectory()` also return the server's caching hints, `ttlMs` and `cacheScope`, and throw an `SdkError` when a response leaves either out.

::: info Dynamic skills
An entry whose `resources` is `"dynamic"` has no file list. `read` then skips the size and digest checks and returns `verified: false`, but still compares the `SKILL.md` frontmatter.
:::

::: warning Host responsibilities
Accept skills up to `SKILL_LIMITS` (512 files, 16 MiB) and explain why you decline one, get approval before you load a skill from a server, and record which server each skill came from. Read a skill's files when you load it, never while listing.
:::

## Recap

- `new SkillsClient(client)` wraps a connected client; `list()` returns entries without reading files.
- `list()` throws on an invalid entry; `skipInvalid: true` keeps the valid skills and returns the refused ones in `invalid`.
- `read(entry)` verifies `SKILL.md` (size, digest, frontmatter) and returns its frontmatter and body.
- `read(entry, path)` resolves a path against the skill's folder and verifies that file.
- A failed check throws `SkillVerificationError` with a `reason`.

<!-- #endregion guide -->
