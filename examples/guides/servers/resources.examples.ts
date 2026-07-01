/**
 * Companion example for `docs/servers/resources.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/resources.examples.ts    # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerResource_static
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
//#endregion registerResource_static

//#region registerResource_report
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
//#endregion registerResource_report

//#region registerResource_template
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
//#endregion registerResource_template

//#region registerResource_list
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
//#endregion registerResource_list

//#region registerResource_file
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
//#endregion registerResource_file

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output servers/resources.md quotes verbatim. Any MCP client behaves the same.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'resources-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Return the contents from the read callback" — the two-item result the page quotes.
//#region readResource_report
const { contents } = await client.readResource({ uri: 'report://latest' });
console.log(contents);
//#endregion readResource_report

// "Add a resource template" — the parameterized read the page quotes.
//#region readResource_template
const profile = await client.readResource({ uri: 'users://7/profile' });
console.log(profile.contents);
//#endregion readResource_template

// "List the template's instances" — the merged list the page quotes. Must contain
// the static URIs and the team:// instances, and no users:// URI.
//#region listResources
const { resources } = await client.listResources();
console.log(resources.map(resource => resource.uri));
//#endregion listResources

const uris = resources.map(resource => resource.uri);
if (uris.some(uri => uri.startsWith('users://')) || !uris.includes('teams://core/roster')) {
    throw new Error(`resources.md list claim failed: ${JSON.stringify(uris)}`);
}

// "Tell clients when a resource changes" — explicit list_changed.
//#region sendResourceListChanged
server.sendResourceListChanged();
//#endregion sendResourceListChanged

await client.close();
await server.close();
