---
shape: how-to
---

# Skills (extension)

The [MCP Skills extension](https://github.com/modelcontextprotocol/ext-skills) (`io.modelcontextprotocol/skills`) lets a server publish [Agent Skills](https://agentskills.io/): directories of instructions, each with a `SKILL.md`, that a host can load into its model. `@modelcontextprotocol/server/ext/skills` is the server side, as a [server extension](../advanced/extensions.md). It serves `skills/list`, `skills/get` and, optionally, `resources/directory/read`. Your server supplies the skill entries through a `SkillSource`, and serves the skill files as ordinary resources.

## Describe a skill

A skill entry names its `SKILL.md`, repeats that file's frontmatter, and lists every file of the skill with its SHA-256 digest and size. `skillResourceOf(uri, content)` computes a file's line in that list.

```ts
import type { Skill } from '@modelcontextprotocol/server/ext/skills';
import { skillResourceOf } from '@modelcontextprotocol/server/ext/skills';

const files = {
    'skill://git-workflow/SKILL.md': '---\nname: git-workflow\ndescription: Follow our Git conventions\n---\n\nBranch from main.\n'
};

const gitWorkflow: Skill = {
    uri: 'skill://git-workflow/SKILL.md',
    frontmatter: { name: 'git-workflow', description: 'Follow our Git conventions' },
    resources: await Promise.all(Object.entries(files).map(([uri, text]) => skillResourceOf(uri, text)))
};
```

The frontmatter must match the `SKILL.md` exactly, and the URI's last directory must equal `frontmatter.name`. The server checks the second rule, and the entry's other structural rules, and answers `-32603` rather than send an entry that breaks one. A skill generated per request, with no stable digests, sets `resources: 'dynamic'`.

## Install the extension

`SkillsExtension` takes the source. `list` returns a page of entries (an empty or partial listing is allowed). `get` answers for any skill the server serves, listed or not, and returns `undefined` for anything else, which the client receives as `-32602`.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';

const skills = new SkillsExtension(
    {
        list: () => ({ skills: [gitWorkflow] }),
        get: ({ uri }) => (uri === gitWorkflow.uri ? gitWorkflow : undefined)
    },
    { cacheHint: { ttlMs: 300_000, cacheScope: 'public' } }
);

const server = new McpServer({ name: 'skills-server', version: '1.0.0' }, { extensions: [skills] });

for (const [uri, text] of Object.entries(files)) {
    server.registerResource(uri, uri, { mimeType: 'text/markdown' }, () => ({ contents: [{ uri, mimeType: 'text/markdown', text }] }));
}
```

The server declares `io.modelcontextprotocol/skills` under `capabilities.extensions`, along with the `resources` capability the extension requires. `cacheHint` sets the `ttlMs` and `cacheScope` on `skills/list` and `skills/get` results. Both default to `0` and `'private'`.

## Serve directory reads

A source that implements `readDirectory` also gets `resources/directory/read`, and the server declares `directoryRead: true`. It returns the direct children of a directory such as `skill://pdf-processing/templates`, with subdirectories marked `mimeType: 'inode/directory'`, or `undefined` when the URI is not a directory.
