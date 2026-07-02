/**
 * Companion example for `docs/servers/completion.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/completion.examples.ts    # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region completable_language
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
//#endregion completable_language

// "Return suggestions from the complete callback" — `repo` completes from an
// async lookup; `branch` points at `completeBranch`, defined in the next region.
//#region registerPrompt_async
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
//#endregion registerPrompt_async

// "Use the other arguments for context" — `branch` suggestions depend on the
// `repo` the client has already filled in. Function declarations hoist, so the
// registration above can reference this by name.
//#region completeCallback_context
async function completeBranch(value: string, context?: { arguments?: Record<string, string> }): Promise<string[]> {
    const repo = context?.arguments?.repo;
    if (!repo) return [];
    return (branchesByRepo[repo] ?? []).filter(branch => branch.startsWith(value));
}
//#endregion completeCallback_context

// "Complete a resource template variable" — the template's `complete` map.
//#region resourceTemplate_complete
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
//#endregion resourceTemplate_complete

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the requests
// whose output servers/completion.md quotes verbatim. Any MCP client behaves
// the same. Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'completion-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// Proof for "Wrap an argument with `completable`": the first completable
// registration advertised the `completions` capability without any declaration.
if (!client.getServerCapabilities()?.completions) {
    throw new Error('completion.md claim failed: completions capability was not advertised');
}

// Proof for "Wrap an argument with `completable`": `language` typed as `ty`.
const language = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-code' },
    argument: { name: 'language', value: 'ty' }
});
if (language.completion.values.join(',') !== 'typescript') {
    throw new Error(`completion.md claim failed: language 'ty' -> ${JSON.stringify(language.completion.values)}`);
}

// "Return suggestions from the complete callback" — the async `repo` result the page quotes.
const repo = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-pr' },
    argument: { name: 'repo', value: 'ty' }
});
console.log(repo.completion);

// "Use the other arguments for context" — the context-narrowed `branch` result the page quotes.
const branch = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-pr' },
    argument: { name: 'branch', value: 'rel' },
    context: { arguments: { repo: 'typescript-sdk' } }
});
console.log(branch.completion);

// "Use the other arguments for context" — without context the callback returns nothing.
const branchNoContext = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-pr' },
    argument: { name: 'branch', value: 'rel' }
});
if (branchNoContext.completion.values.length !== 0) {
    throw new Error(`completion.md claim failed: branch without context -> ${JSON.stringify(branchNoContext.completion.values)}`);
}

// Proof for "Complete a resource template variable": the request targets the
// template by its URI pattern.
const templateRepo = await client.complete({
    ref: { type: 'ref/resource', uri: 'repo://{repo}/readme' },
    argument: { name: 'repo', value: 'py' }
});
if (templateRepo.completion.values.join(',') !== 'python-sdk') {
    throw new Error(`completion.md claim failed: template repo 'py' -> ${JSON.stringify(templateRepo.completion.values)}`);
}

// "Try it from a client" — the call and output the page quotes.
//#region complete_client
const result = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-code' },
    argument: { name: 'language', value: '' }
});
console.log(result.completion);
//#endregion complete_client

await client.close();
await server.close();
