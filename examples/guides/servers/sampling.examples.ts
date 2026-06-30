/**
 * Companion example for `docs-v2/servers/sampling.md`.
 *
 * The `ts` fence on that page is synced from the `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * region connects in-memory clients whose sampling handlers stand in for a
 * host LLM, and produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/sampling.examples.ts      # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// The page's one code block. Wrapped in a function so the harness can stand up
// two independent server instances (one per client) without duplicating it.
function registerTool_sampling(server: McpServer) {
    //#region registerTool_sampling
    server.registerTool(
        'summarize',
        {
            description: 'Summarize text using the client LLM',
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }, ctx) => {
            const response = await ctx.mcpReq.requestSampling({
                messages: [{ role: 'user', content: { type: 'text', text: `Summarize in one sentence:\n\n${text}` } }],
                maxTokens: 500
            });
            return { content: [{ type: 'text', text: `Model (${response.model}): ${JSON.stringify(response.content)}` }] };
        }
    );
    //#endregion registerTool_sampling
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client declares the sampling
// capability and answers `sampling/createMessage` the way a host would — by
// running the prompt through its model. Here the "model" is canned so the run
// is deterministic; any MCP client behaves the same over stdio or HTTP.
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'summarizer', version: '1.0.0' });
registerTool_sampling(server);

const client = new Client({ name: 'sampling-docs-harness', version: '1.0.0' }, { capabilities: { sampling: {} } });

client.setRequestHandler('sampling/createMessage', async () => {
    return {
        model: 'host-model',
        role: 'assistant' as const,
        content: { type: 'text' as const, text: 'Sampling lets a tool ask the client for a completion.' }
    };
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Read the model's reply" — the result the page quotes verbatim.
const result = await client.callTool({
    name: 'summarize',
    arguments: { text: 'Sampling is a server-to-client request for an LLM completion...' }
});
console.log(result.content);

await client.close();
await server.close();

// "Require the sampling capability" — a strict server and a client that never
// declared `sampling`. The SDK rejects the request before it reaches the wire;
// the page quotes the resulting tool error verbatim.
const bareServer = new McpServer({ name: 'summarizer', version: '1.0.0' }, { enforceStrictCapabilities: true });
registerTool_sampling(bareServer);

const bare = new Client({ name: 'no-sampling-harness', version: '1.0.0' });
const [bareClientTransport, bareServerTransport] = InMemoryTransport.createLinkedPair();
await bareServer.connect(bareServerTransport);
await bare.connect(bareClientTransport);

const rejected = await bare.callTool({ name: 'summarize', arguments: { text: 'anything' } });
console.log(rejected);

await bare.close();
await bareServer.close();
