/**
 * Companion example for `docs/clients/server-requests.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects this client over an in-memory transport pair to a server
 * whose tools elicit input and request sampling, and produces the output the
 * page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/clients/server-requests.examples.ts     # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region Client_capabilities
import { Client } from '@modelcontextprotocol/client';

const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: {
            sampling: {},
            elicitation: { form: {}, url: {} }
        }
    }
);
//#endregion Client_capabilities

// "Handle an elicitation request" — one handler, both modes.
//#region setRequestHandler_elicitation
client.setRequestHandler('elicitation/create', async request => {
    if (request.params.mode === 'url') {
        // Open request.params.url in the user's browser; answer when they finish.
        return { action: 'accept' };
    }
    // Render request.params.requestedSchema as a form; return what the user entered.
    return { action: 'accept', content: { city: 'Lisbon' } };
});
//#endregion setRequestHandler_elicitation

// "Handle a sampling request" — a canned model stands in for a real provider.
//#region setRequestHandler_sampling
client.setRequestHandler('sampling/createMessage', async request => {
    const lastMessage = request.params.messages.at(-1);
    console.log('Sampling request:', lastMessage?.content);

    // In production, run the messages through your model here.
    return {
        model: 'host-model',
        role: 'assistant',
        content: { type: 'text', text: 'One travel mug to Lisbon.' }
    };
});
//#endregion setRequestHandler_sampling

// "Cap or disable automatic fulfilment" — the same constructor with the
// `inputRequired` option added. Wrapped so the file keeps a single live client.
function Client_inputRequired() {
    //#region Client_inputRequired
    const client = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            capabilities: { sampling: {}, elicitation: { form: {}, url: {} } },
            inputRequired: { maxRounds: 3 }
        }
    );
    //#endregion Client_inputRequired
    return client;
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A server whose tools elicit input and
// request sampling drives the handlers above over an in-memory transport pair.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { getSupportedElicitationModes, InMemoryTransport } = await import('@modelcontextprotocol/client');
const { McpServer } = await import('@modelcontextprotocol/server');
const z = await import('zod/v4');

const server = new McpServer({ name: 'orders', version: '1.0.0' });

// Form-mode elicitation: docs/servers/elicitation.md owns this side.
server.registerTool(
    'place-order',
    {
        description: 'Place an order after collecting a shipping city',
        inputSchema: z.object({ item: z.string() })
    },
    async ({ item }, ctx) => {
        const answer = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Where should we ship the ${item}?`,
            requestedSchema: {
                type: 'object',
                properties: { city: { type: 'string', title: 'City' } },
                required: ['city']
            }
        });
        if (answer.action !== 'accept') {
            return { content: [{ type: 'text', text: `Order ${answer.action}.` }] };
        }
        return { content: [{ type: 'text', text: `Order placed: ${item} ships to ${answer.content?.city}.` }] };
    }
);

// URL-mode elicitation: exercises the handler's `url` branch.
server.registerTool(
    'link-card',
    {
        description: 'Link a payment card through a hosted flow',
        inputSchema: z.object({ provider: z.string() })
    },
    async ({ provider }, ctx) => {
        const answer = await ctx.mcpReq.elicitInput({
            mode: 'url',
            message: `Sign in to ${provider} to link your card`,
            url: `https://pay.example.com/link/${encodeURIComponent(provider)}`,
            elicitationId: crypto.randomUUID()
        });
        return { content: [{ type: 'text', text: `Card link: ${answer.action}.` }] };
    }
);

// Sampling: docs/servers/sampling.md owns this side.
server.registerTool(
    'summarize-order',
    {
        description: 'Summarize the latest order with the host model',
        inputSchema: z.object({ order: z.string() })
    },
    async ({ order }, ctx) => {
        const response = await ctx.mcpReq.requestSampling({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize this order: ${order}` } }],
            maxTokens: 200
        });
        const block = Array.isArray(response.content) ? response.content[0] : response.content;
        const summary = block?.type === 'text' ? block.text : '(non-text)';
        return { content: [{ type: 'text', text: `${response.model}: ${summary}` }] };
    }
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Handle an elicitation request" — the form round trip the page quotes.
const placed = await client.callTool({ name: 'place-order', arguments: { item: 'Travel mug' } });
console.log(placed.content);

// "Handle a sampling request" — the handler logs the prompt it received, then
// the tool result carries the handler's completion. Both lines are quoted.
const summarized = await client.callTool({ name: 'summarize-order', arguments: { order: '1 Travel mug to Lisbon' } });
console.log(summarized.content);

// Proof for the elicitation section's `url` branch — not quoted on the page,
// but the run fails (non-zero exit) if the branch stops working.
const linked = await client.callTool({ name: 'link-card', arguments: { provider: 'examplepay' } });
const linkedText = linked.content?.[0];
if (linkedText?.type !== 'text' || linkedText.text !== 'Card link: accept.') {
    throw new Error(`server-requests.md url-branch claim failed: ${JSON.stringify(linked.content)}`);
}

// Proof for the page's ::: tip — an empty `elicitation: {}` capability means
// form mode only; `url` has to be declared explicitly.
const modes = getSupportedElicitationModes({});
if (modes.supportsFormMode !== true || modes.supportsUrlMode !== false) {
    throw new Error(`server-requests.md tip claim failed: ${JSON.stringify(modes)}`);
}

// Keep the round-cap constructor type-checked (its region is page-only).
void Client_inputRequired;

await client.close();
await server.close();
