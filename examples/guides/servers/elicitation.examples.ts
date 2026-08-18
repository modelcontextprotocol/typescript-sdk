/**
 * Companion example for `docs/servers/elicitation.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions drives every elicitation round over an in-memory transport pair and
 * prints the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/elicitation.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerTool_elicitForm
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'feedback', version: '1.0.0' });

server.registerTool(
    'collect-feedback',
    {
        description: 'Ask the user how something went',
        inputSchema: z.object({ topic: z.string() })
    },
    async ({ topic }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `How was ${topic}?`,
            requestedSchema: {
                type: 'object',
                properties: {
                    rating: { type: 'number', title: 'Rating (1-5)', minimum: 1, maximum: 5 },
                    comment: { type: 'string', title: 'Comment' }
                },
                required: ['rating']
            }
        });
        if (result.action !== 'accept') {
            return { content: [{ type: 'text', text: `Feedback ${result.action}.` }] };
        }
        return { content: [{ type: 'text', text: `Recorded: ${JSON.stringify(result.content)}` }] };
    }
);
//#endregion registerTool_elicitForm

// "Handle every action" — a confirmation form whose handler answers all three actions.
//#region registerTool_elicitActions
server.registerTool(
    'delete-dataset',
    {
        description: 'Delete a dataset after the user confirms',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Delete ${name}? This cannot be undone.`,
            requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Yes, delete it' } },
                required: ['confirm']
            }
        });
        switch (result.action) {
            case 'accept':
                if (result.content?.confirm !== true) {
                    return { content: [{ type: 'text', text: 'Box left unchecked - nothing deleted.' }] };
                }
                return { content: [{ type: 'text', text: `Deleted ${name}.` }] };
            case 'decline':
                return { content: [{ type: 'text', text: 'Declined - nothing deleted.' }] };
            case 'cancel':
                return { content: [{ type: 'text', text: 'Dismissed - ask again later.' }] };
        }
    }
);
//#endregion registerTool_elicitActions

// "Prefill a field with a default" — the requested schema carries `default`.
// Wrapped so the harness can register the same tool on a second server whose
// client declares `applyDefaults`; the page's fence shows the body unindented.
function registerExportReport(server: McpServer): void {
    //#region registerTool_elicitDefault
    server.registerTool(
        'export-report',
        {
            description: 'Export a report after the user picks a format',
            inputSchema: z.object({ name: z.string() })
        },
        async ({ name }, ctx) => {
            const result = await ctx.mcpReq.elicitInput({
                mode: 'form',
                message: `Export ${name} as which format?`,
                requestedSchema: {
                    type: 'object',
                    properties: { format: { type: 'string', title: 'Format', enum: ['pdf', 'csv'], default: 'pdf' } },
                    required: ['format']
                }
            });
            if (result.action !== 'accept') {
                return { content: [{ type: 'text', text: `Export ${result.action}.` }] };
            }
            return { content: [{ type: 'text', text: `Exported ${name} as ${result.content?.format}.` }] };
        }
    );
    //#endregion registerTool_elicitDefault
}
registerExportReport(server);

// "Send the end user to a URL" — url mode hands the browser flow to the client.
//#region registerTool_elicitUrl
server.registerTool(
    'link-account',
    {
        description: 'Link a billing account through a hosted sign-in flow',
        inputSchema: z.object({ provider: z.string() })
    },
    async ({ provider }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'url',
            message: `Sign in to ${provider} to link your account`,
            url: `https://billing.example.com/connect/${encodeURIComponent(provider)}`,
            elicitationId: crypto.randomUUID()
        });
        if (result.action !== 'accept') {
            return { content: [{ type: 'text', text: `Sign-in ${result.action}.` }] };
        }
        return { content: [{ type: 'text', text: `Linked ${provider}.` }] };
    }
);
//#endregion registerTool_elicitUrl

// ---------------------------------------------------------------------------
// Harness (not shown on the page beyond the two regions below). An in-memory
// client plays the end user; a real host renders UI instead. Imported
// dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

// The client-side handler the page shows once (the full client story lives in
// docs/clients/server-requests.md).
//#region Client_elicitationHandler
const client = new Client({ name: 'feedback-host', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });

client.setRequestHandler('elicitation/create', async request => {
    if (request.params.mode === 'url') {
        // Open request.params.url in the user's browser; answer when they finish.
        return { action: 'accept' };
    }
    // Render request.params.requestedSchema as a form; return what the user typed.
    return { action: 'accept', content: { rating: 5, comment: 'Smooth setup' } };
});
//#endregion Client_elicitationHandler

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Ask for input with a form" — the accept round trip the page quotes.
//#region callTool_collectFeedback
const result = await client.callTool({ name: 'collect-feedback', arguments: { topic: 'the new editor' } });
console.log(result.content);
//#endregion callTool_collectFeedback

// "Send the end user to a URL" — the handler's url branch accepts.
const linked = await client.callTool({ name: 'link-account', arguments: { provider: 'github' } });
console.log(linked.content);

// "Handle every action" — the end user clicks Decline; the harness simulates
// that by swapping in a handler that declines every request.
client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));
const declined = await client.callTool({ name: 'delete-dataset', arguments: { name: 'staging-snapshots' } });
console.log(declined.content);

// "Prefill a field with a default" — a client that declares `applyDefaults`
// accepts with `format` left out; the SDK fills it from the schema before the
// accept reaches the handler.
const defaultsClient = new Client(
    { name: 'defaults-host', version: '1.0.0' },
    { capabilities: { elicitation: { form: { applyDefaults: true } } } }
);
defaultsClient.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
const [defaultsClientTransport, defaultsServerTransport] = InMemoryTransport.createLinkedPair();
const defaultsServer = new McpServer({ name: 'feedback', version: '1.0.0' });
registerExportReport(defaultsServer);
await defaultsServer.connect(defaultsServerTransport);
await defaultsClient.connect(defaultsClientTransport);
const exported = await defaultsClient.callTool({ name: 'export-report', arguments: { name: 'quarterly-sales' } });
console.log(exported.content);
const exportedText = Array.isArray(exported.content) && exported.content[0]?.type === 'text' ? exported.content[0].text : undefined;
if (exported.isError || exportedText !== 'Exported quarterly-sales as pdf.') {
    throw new Error(`elicitation.md claim failed: applyDefaults round returned ${JSON.stringify(exported.content)}`);
}
await defaultsClient.close();
await defaultsServer.close();

// "Require the elicitation capability" — the same form tool served to a client
// that never declared the elicitation capability. elicitInput throws before
// anything reaches the wire and the message becomes the tool result.
const plainServer = new McpServer({ name: 'feedback', version: '1.0.0' });
plainServer.registerTool(
    'collect-feedback',
    { description: 'Ask the user how something went', inputSchema: z.object({ topic: z.string() }) },
    async ({ topic }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `How was ${topic}?`,
            requestedSchema: { type: 'object', properties: { rating: { type: 'number' } }, required: ['rating'] }
        });
        return { content: [{ type: 'text', text: result.action }] };
    }
);
const plainClient = new Client({ name: 'no-elicitation-host', version: '1.0.0' });
const [plainClientTransport, plainServerTransport] = InMemoryTransport.createLinkedPair();
await plainServer.connect(plainServerTransport);
await plainClient.connect(plainClientTransport);
const failed = await plainClient.callTool({ name: 'collect-feedback', arguments: { topic: 'anything' } });
console.log(failed);

await plainClient.close();
await plainServer.close();
await client.close();
await server.close();
