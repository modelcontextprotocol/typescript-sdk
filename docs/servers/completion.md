---
shape: how-to
---
# Completion

**Completion** is server-side autocomplete for prompt arguments and resource template variables: the client sends the partial value the user has typed so far, your callback returns the matching suggestions.

## Wrap an argument with `completable`

`completable` wraps one field of a [prompt's](./prompts.md) `argsSchema` — the schema validates exactly as before, and the second argument suggests values for the field.

```ts source="../../examples/guides/servers/completion.examples.ts#completable_language"
import { completable, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const languages = ['typescript', 'javascript', 'python', 'rust', 'go'];

const server = new McpServer({ name: 'review', version: '1.0.0' });

server.registerPrompt(
    'review-code',
    {
        description: 'Review code for best practices',
        argsSchema: z.object({
            language: completable(z.string().describe('Programming language'), value =>
                languages.filter(language => language.startsWith(value))
            )
        })
    },
    ({ language }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review this ${language} code for best practices.` }
            }
        ]
    })
);
```

The first `completable` field also registers the server's `completion/complete` handler and advertises the **completions** capability — nothing to declare. A request for completions of `language` with the partial value `ty` now returns `typescript`.

Every result quoted on this page comes from `client.complete()` on an in-memory `Client` connected to this server — [Try it from a client](#try-it-from-a-client) shows the call, and [Test a server](../testing.md) shows the wiring.

## Return suggestions from the complete callback

The callback receives the value typed so far and returns every match — `string[]`, or a promise of one when the lookup is async. Register a second prompt whose `repo` argument completes from an async list.

```ts source="../../examples/guides/servers/completion.examples.ts#registerPrompt_async"
const branchesByRepo: Record<string, string[]> = {
    'typescript-sdk': ['main', 'release/1.x', 'release/2.x'],
    'python-sdk': ['main', 'release/1.x'],
    inspector: ['main']
};

async function listRepos(): Promise<string[]> {
    return Object.keys(branchesByRepo);
}

server.registerPrompt(
    'review-pr',
    {
        description: 'Review the open pull requests on one branch',
        argsSchema: z.object({
            repo: completable(z.string().describe('Repository name'), async value => {
                const repos = await listRepos();
                return repos.filter(repo => repo.startsWith(value));
            }),
            branch: completable(z.string().describe('Target branch'), completeBranch)
        })
    },
    ({ repo, branch }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review the open pull requests on ${repo}@${branch}.` }
            }
        ]
    })
);
```

Return the full match list; the SDK truncates `values` to 100 entries and fills in `total` and `hasMore`. Completing `repo` with the value `ty` returns:

```
{ values: [ 'typescript-sdk' ], total: 1, hasMore: false }
```

`branch` points at `completeBranch`, defined in the next section.

## Use the other arguments for context

The callback's optional second parameter carries `arguments`: the values the client has already filled in for the prompt's other arguments. Use it to make one field's suggestions depend on another's.

```ts source="../../examples/guides/servers/completion.examples.ts#completeCallback_context"
async function completeBranch(value: string, context?: { arguments?: Record<string, string> }): Promise<string[]> {
    const repo = context?.arguments?.repo;
    if (!repo) return [];
    return (branchesByRepo[repo] ?? []).filter(branch => branch.startsWith(value));
}
```

With `repo: 'typescript-sdk'` already filled in, completing `branch` with the value `rel` returns:

```
{ values: [ 'release/1.x', 'release/2.x' ], total: 2, hasMore: false }
```

Clients are not required to send `context` — return an empty list when it is missing, never throw.

## Complete a resource template variable

[Resource template](./resources.md) variables complete through the template's `complete` map — one callback per URI variable, with the same `(value, context?)` signature. `completable` is for prompt arguments only.

```ts source="../../examples/guides/servers/completion.examples.ts#resourceTemplate_complete"
server.registerResource(
    'readme',
    new ResourceTemplate('repo://{repo}/readme', {
        list: undefined,
        complete: {
            repo: async value => {
                const repos = await listRepos();
                return repos.filter(repo => repo.startsWith(value));
            }
        }
    }),
    { description: 'The README of one repository' },
    async (uri, { repo }) => ({
        contents: [{ uri: uri.href, text: `Repository: ${repo}` }]
    })
);
```

The completion request targets the template by its URI pattern: `ref: { type: 'ref/resource', uri: 'repo://{repo}/readme' }` with `argument: { name: 'repo', value: 'py' }` returns `python-sdk`.

## Try it from a client

`Client.complete()` sends `completion/complete`. Complete `language` on `review-code` with an empty value to get the whole list.

```ts source="../../examples/guides/servers/completion.examples.ts#complete_client"
const result = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-code' },
    argument: { name: 'language', value: '' }
});
console.log(result.completion);
```

The server's callback ran once and produced every value:

```
{
  values: [ 'typescript', 'javascript', 'python', 'rust', 'go' ],
  total: 5,
  hasMore: false
}
```

::: tip
A host issues the same request as the end user types: MCP Inspector requests completions while you fill in a prompt's arguments and shows the returned `values` as suggestions.
:::

## Recap

- `completable(schema, callback)` attaches autocompletion to one prompt argument; the schema validates exactly as before.
- The callback receives the partial value and returns the full match list, synchronously or as a promise; the SDK caps `values` at 100 and sets `total` and `hasMore`.
- `context.arguments` carries the prompt's already-filled arguments, so one field's suggestions can depend on another's.
- Resource template variables complete through the template's `complete` map, not `completable`.
- The first completable registration advertises the `completions` capability; `Client.complete()` sends the request.
