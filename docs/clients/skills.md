---
shape: how-to
---

# Skills (extension)

The [MCP Skills extension](https://github.com/modelcontextprotocol/ext-skills) (`io.modelcontextprotocol/skills`) lets a server publish [Agent Skills](https://agentskills.io/). `@modelcontextprotocol/client/ext/skills` is the client side, as a client extension: it lists and gets skill entries, reads directories, and reads skill files verified against their entry.

## Install the extension

```ts
import { Client } from '@modelcontextprotocol/client';
import { SkillsClientExtension } from '@modelcontextprotocol/client/ext/skills';

const skills = new SkillsClientExtension();
const client = new Client({ name: 'host', version: '1.0.0' }, { extensions: [skills] });
await client.connect(transport);
```

Every method refuses with `CapabilityNotSupported` unless the server declared the extension and the `resources` capability. `readDirectory` also needs the server to declare `directoryRead`.

## List and get skills

`list` returns one page of entries. Pass `nextCursor` back as `cursor` for the next page. An entry is the full manifest: frontmatter, plus every file with its digest and size. `get(uri)` returns the entry for one skill by the URI of its `SKILL.md`, whether or not the listing included it.

```ts
const { skills: entries, nextCursor } = await skills.list();
const { skill } = await skills.get('skill://git-workflow/SKILL.md');
```

## Read a skill file

`read(skill, uri)` fetches the file with `resources/read` and checks it against the entry. The file must be listed, and its size and SHA-256 digest must match. Any mismatch throws `SdkError` with `InvalidResult`. Refresh the entry with `get` and ask the user to approve the skill again.

```ts
const manifest = await skills.read(skill, skill.uri);
```

A skill with `resources: 'dynamic'` has nothing to verify against, so its files come back as read. The extension leaves two checks to the host: comparing a `SKILL.md`'s frontmatter with the entry (this needs a YAML parser), and the specification's [security requirements](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx#security-considerations) for loading skills into a model.
