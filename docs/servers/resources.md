---
shape: how-to
---

# Resources

A **resource** is read-only data — a file, a database row, a rendered report — that a connected client lists, reads, and attaches as context for the model. The client decides what to read: resources are application-controlled, where [tools](./tools.md) are model-controlled.

## Register a static resource

`registerResource` takes a name, a fixed URI, metadata, and a read callback.

```ts source="../../examples/guides/servers/resources.examples.ts#registerResource_static"
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'workspace', version: '1.0.0' });

server.registerResource(
    'config',
    'config://app',
    {
        title: 'Application Config',
        description: 'Application configuration data',
        mimeType: 'text/plain'
    },
    async uri => ({
        contents: [{ uri: uri.href, text: 'log_level=info\nregion=eu-west-1' }]
    })
);
```

`resources/list` now advertises `config://app` with that metadata, and `resources/read` on `config://app` runs the callback.

::: info Coming from v1?
`registerResource` replaces `resource()` — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Return the contents from the read callback

The callback returns `{ contents: [...] }`. Add a resource whose contents hold two items: each one echoes the `uri` it answers for and carries either `text` or a base64 `blob`.

```ts source="../../examples/guides/servers/resources.examples.ts#registerResource_report"
// A 1x1 PNG; a production server reads these bytes from disk or object storage.
const chartPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

server.registerResource(
    'report',
    'report://latest',
    {
        title: 'Latest usage report',
        description: 'Weekly usage summary with a rendered chart',
        mimeType: 'text/markdown'
    },
    async uri => ({
        contents: [
            { uri: uri.href, mimeType: 'text/markdown', text: 'Active installs grew 12% week over week.' },
            { uri: uri.href, mimeType: 'image/png', blob: chartPng }
        ]
    })
);
```

Every call on this page comes from an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring — and an MCP host does the same over stdio or HTTP. Read the resource.

```ts source="../../examples/guides/servers/resources.examples.ts#readResource_report"
const { contents } = await client.readResource({ uri: 'report://latest' });
console.log(contents);
```

The callback's array comes back unchanged, one entry per item:

```
[
  {
    uri: 'report://latest',
    mimeType: 'text/markdown',
    text: 'Active installs grew 12% week over week.'
  },
  {
    uri: 'report://latest',
    mimeType: 'image/png',
    blob: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
  }
]
```

The `mimeType` on each item describes that item; the `mimeType` in the registration config describes the resource as a whole in `resources/list`.

## Add a resource template

A `ResourceTemplate` registers a whole URI pattern instead of one URI. `list` is a required key — pass `undefined` when the instances are unbounded.

```ts source="../../examples/guides/servers/resources.examples.ts#registerResource_template"
server.registerResource(
    'user-profile',
    new ResourceTemplate('users://{userId}/profile', { list: undefined }),
    {
        title: 'User Profile',
        description: 'Profile data for one user',
        mimeType: 'application/json'
    },
    async (uri, { userId }) => ({
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ userId, plan: 'pro' }) }]
    })
);
```

The matched variables arrive parsed as the read callback's second argument. Read any URI the pattern matches.

```ts source="../../examples/guides/servers/resources.examples.ts#readResource_template"
const profile = await client.readResource({ uri: 'users://7/profile' });
console.log(profile.contents);
```

The callback ran with `userId` bound to `'7'`:

```
[
  {
    uri: 'users://7/profile',
    mimeType: 'application/json',
    text: '{"userId":"7","plan":"pro"}'
  }
]
```

## List the template's instances

`users://{userId}/profile` is readable but never appears in `resources/list` — with `list: undefined` there is nothing to enumerate. Register a template over an enumerable set and give it a `list` callback.

```ts source="../../examples/guides/servers/resources.examples.ts#registerResource_list"
server.registerResource(
    'team-roster',
    new ResourceTemplate('teams://{teamId}/roster', {
        list: async () => ({
            resources: [
                { uri: 'teams://core/roster', name: 'Core team roster' },
                { uri: 'teams://growth/roster', name: 'Growth team roster' }
            ]
        })
    }),
    {
        description: 'Members of one team',
        mimeType: 'text/plain'
    },
    async (uri, { teamId }) => ({
        contents: [{ uri: uri.href, text: `Members of team ${teamId}` }]
    })
);
```

`resources/list` merges the static resources with every template's `list` results:

```ts source="../../examples/guides/servers/resources.examples.ts#listResources"
const { resources } = await client.listResources();
console.log(resources.map(resource => resource.uri));
```

Both `teams://` rosters are discoverable; the `users://` template contributes nothing:

```
[
  'config://app',
  'report://latest',
  'teams://core/roster',
  'teams://growth/roster'
]
```

`resources/templates/list` still advertises both URI patterns (`client.listResourceTemplates()`), so a client that already knows a `userId` builds the concrete URI itself.

## Sanitize file-backed paths

A template variable that becomes a filesystem path is client-controlled input. Resolve it to a real path and reject anything outside the root before you read.

```ts source="../../examples/guides/servers/resources.examples.ts#registerResource_file"
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const DOCS_ROOT = path.resolve('./docs');

server.registerResource(
    'doc',
    new ResourceTemplate('docs://{file}', { list: undefined }),
    {
        description: 'A markdown page from the docs directory',
        mimeType: 'text/markdown'
    },
    async (uri, { file }) => {
        const requested = await realpath(path.join(DOCS_ROOT, String(file)));
        if (!requested.startsWith(DOCS_ROOT + path.sep)) {
            throw new Error(`${uri.href} resolves outside the docs root`);
        }
        return { contents: [{ uri: uri.href, text: await readFile(requested, 'utf8') }] };
    }
);
```

`realpath` collapses `..` segments and symlinks to the path that is actually on disk; the `startsWith` check then rejects anything that escaped `DOCS_ROOT`. Throw on rejection — [Errors](./errors.md) covers how a thrown error reaches the client.

::: warning
Never pass a template variable or a client-supplied URI to a filesystem API unchecked. `..` arrives raw and percent-encoded, and a symlink inside the root can point outside it — compare resolved real paths, never the strings the client sent.
:::

## Tell clients when a resource changes

Registering, enabling, disabling, or removing a resource already sends `notifications/resources/list_changed`. Send it yourself when the set changes for a reason the SDK cannot see.

```ts source="../../examples/guides/servers/resources.examples.ts#sendResourceListChanged"
server.sendResourceListChanged();
```

The notification tells connected clients to call `resources/list` again. A change to one resource's content is a different signal, `notifications/resources/updated` — [Notifications](./notifications.md) covers both.

## Recap

- `registerResource(name, uri, config, readCallback)` registers a resource at a fixed URI.
- The read callback returns `{ contents: [...] }`; each item echoes the `uri` and carries `text` or a base64 `blob`.
- A `ResourceTemplate` registers a URI pattern; the matched variables arrive parsed as the read callback's second argument.
- A template's `list` callback is what makes its instances appear in `resources/list`.
- Resolve file-backed paths to their real location and reject anything outside the root before reading.
- Registration changes emit `notifications/resources/list_changed` automatically.
