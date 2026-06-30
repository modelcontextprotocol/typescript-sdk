/**
 * Companion example for `docs-v2/servers/prompts.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/prompts.examples.ts       # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerPrompt_review
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'review', version: '1.0.0' });

server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices and potential issues',
        argsSchema: z.object({
            code: z.string().describe('The code to review')
        })
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review this code:\n\n${code}` }
            }
        ]
    })
);
//#endregion registerPrompt_review

//#region registerPrompt_messages
server.registerPrompt(
    'explain-error',
    {
        description: 'Explain a compiler error and suggest the smallest fix',
        argsSchema: z.object({ error: z.string() })
    },
    ({ error }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Explain this compiler error:\n\n${error}` }
            },
            {
                role: 'assistant' as const,
                content: { type: 'text' as const, text: 'The one-line cause:' }
            }
        ]
    })
);
//#endregion registerPrompt_messages

//#region registerPrompt_embedResource
const styleGuide = '- Prefer const over let.\n- No single-letter identifiers.';

server.registerResource('style-guide', 'doc://style-guide', { mimeType: 'text/markdown' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: styleGuide }]
}));

server.registerPrompt(
    'review-against-style',
    {
        description: 'Review code against the team style guide',
        argsSchema: z.object({ code: z.string() })
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user' as const,
                content: {
                    type: 'resource' as const,
                    resource: { uri: 'doc://style-guide', mimeType: 'text/markdown', text: styleGuide }
                }
            },
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review this code against the style guide:\n\n${code}` }
            }
        ]
    })
);
//#endregion registerPrompt_embedResource

//#region registerPrompt_completable
import { completable } from '@modelcontextprotocol/server';

server.registerPrompt(
    'translate',
    {
        description: 'Translate a snippet into another language',
        argsSchema: z.object({
            language: completable(z.string(), value =>
                ['typescript', 'python', 'rust', 'go'].filter(language => language.startsWith(value))
            ),
            code: z.string()
        })
    },
    ({ language, code }) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Translate to ${language}:\n\n${code}` } }]
    })
);
//#endregion registerPrompt_completable

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output servers/prompts.md quotes verbatim. Any MCP client behaves the same.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'prompts-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Register a prompt" — the prose claims `prompts/list` advertises `review-code`
// with one required `code` argument carrying the `.describe()` string. Throws
// (non-zero exit) if the claim is false.
const { prompts } = await client.listPrompts();
const reviewPrompt = prompts.find(prompt => prompt.name === 'review-code');
const codeArgument = reviewPrompt?.arguments?.find(argument => argument.name === 'code');
if (codeArgument?.required !== true || codeArgument.description !== 'The code to review') {
    throw new Error(`prompts.md claim failed: review-code argument is ${JSON.stringify(reviewPrompt?.arguments)}`);
}

// "Register a prompt" — the filled-in messages the page quotes.
//#region getPrompt_review
const result = await client.getPrompt({ name: 'review-code', arguments: { code: 'let x = 1' } });
console.log(result.messages);
//#endregion getPrompt_review

// "Validate the arguments with the schema" — the rejection the page quotes.
//#region getPrompt_invalid
import type { ProtocolError } from '@modelcontextprotocol/client';

try {
    await client.getPrompt({ name: 'review-code', arguments: {} });
} catch (error) {
    const { code, message } = error as ProtocolError;
    console.log(code, message);
}
//#endregion getPrompt_invalid

// "Embed a resource in a message" — the embedded-resource message the page quotes.
const review = await client.getPrompt({
    name: 'review-against-style',
    arguments: { code: 'let n = 1' }
});
console.log(review.messages[0]);

await client.close();
await server.close();
