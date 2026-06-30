/**
 * Companion example for `docs/servers/input-required.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client with an elicitation handler and
 * produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/input-required.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { CallToolResult, ElicitResult, InputRequiredResult, ProtocolError } from '@modelcontextprotocol/server';
import {
    acceptedContent,
    createRequestStateCodec,
    inputRequired,
    inputResponse,
    McpServer,
    ProtocolErrorCode
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// "Protect `requestState` with the codec" — the page shows this block AFTER the
// handlers that use `stateCodec`, but module evaluation needs it first.
//#region requestState_codec
const stateCodec = createRequestStateCodec<{ step: string }>({
    key: crypto.getRandomValues(new Uint8Array(32)), // >= 32 bytes; share it across instances in a fleet
    ttlSeconds: 600
});

const server = new McpServer(
    { name: 'releases', version: '1.0.0' },
    { requestState: { verify: stateCodec.verify } }
);
//#endregion requestState_codec

// "Return `input_required` instead of pushing a request"
//#region registerTool_inputRequired
server.registerTool(
    'deploy',
    {
        description: 'Deploy after the operator confirms',
        inputSchema: z.object({ env: z.string() })
    },
    async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Deploy to ${env}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
    }
);
//#endregion registerTool_inputRequired

// "Read the responses on re-entry" — the schema-aware overload + the declined branch.
//#region acceptedContent_schema
server.registerTool(
    'tag-release',
    {
        description: 'Tag a release after the operator confirms',
        inputSchema: z.object({ tag: z.string() })
    },
    async ({ tag }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (view.kind === 'elicit' && view.action !== 'accept') {
            return { content: [{ type: 'text', text: 'Tagging cancelled by the operator' }], isError: true };
        }
        const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', z.object({ confirm: z.boolean() }));
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Tag ${tag}?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Tagged ${tag}` }] };
    }
);
//#endregion acceptedContent_schema

// "Write the handler write-once" — two missing inputs requested in one round.
//#region registerTool_writeOnce
server.registerTool(
    'provision',
    { description: 'Provision a database', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const name = acceptedContent(ctx.mcpReq.inputResponses, 'name', z.object({ name: z.string() }));
        const region = acceptedContent(ctx.mcpReq.inputResponses, 'region', z.object({ region: z.string() }));
        if (name === undefined || region === undefined) {
            return inputRequired({
                inputRequests: {
                    ...(name === undefined && {
                        name: inputRequired.elicit({
                            message: 'Database name?',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                        })
                    }),
                    ...(region === undefined && {
                        region: inputRequired.elicit({
                            message: 'Which region?',
                            requestedSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] }
                        })
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Provisioned ${name.name} in ${region.region}` }] };
    }
);
//#endregion registerTool_writeOnce

// "Carry state across rounds with `requestState`" — two sequential rounds.
//#region requestState_mint
server.registerTool(
    'wipe-cache',
    { description: 'Confirm, then pick a scope, then wipe', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const state = ctx.mcpReq.requestState<{ step: string }>();

        if (state?.step !== 'confirmed') {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Really wipe the cache?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        })
                    }
                });
            }
            // Mint only what the response above already proved: the operator confirmed.
            return inputRequired({
                inputRequests: {
                    scope: inputRequired.elicit({
                        message: 'Which scope?',
                        requestedSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] }
                    })
                },
                requestState: await stateCodec.mint({ step: 'confirmed' })
            });
        }

        const scope = acceptedContent<{ scope: string }>(ctx.mcpReq.inputResponses, 'scope');
        return { content: [{ type: 'text', text: `Wiped ${scope?.scope ?? 'all'}` }] };
    }
);
//#endregion requestState_mint

/** "Pick the embedded request kind" — all four builders in one map (typecheck-only). */
export function inputRequired_kinds(): InputRequiredResult {
    //#region inputRequired_kinds
    const next = inputRequired({
        inputRequests: {
            confirm: inputRequired.elicit({
                message: 'Continue?',
                requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
            }),
            signin: inputRequired.elicitUrl({ message: 'Sign in to continue', url: 'https://example.com/auth' }),
            summary: inputRequired.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the diff' } }],
                maxTokens: 200
            }),
            roots: inputRequired.listRoots()
        }
    });
    //#endregion inputRequired_kinds
    return next;
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client with an elicitation
// handler drives the calls whose output servers/input-required.md quotes
// verbatim. Any MCP client behaves the same; the SDK's legacy shim fulfils
// these `input_required` returns over the 2025-era linked pair.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client(
    { name: 'input-required-docs-harness', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } }
);

const answers: Record<string, Record<string, string | boolean>> = {
    'Deploy to prod?': { confirm: true },
    'Database name?': { name: 'analytics' },
    'Which region?': { region: 'eu-west-1' },
    'Really wipe the cache?': { confirm: true },
    'Which scope?': { scope: 'sessions' }
};

const acceptHandler = async (request: { params: { message: string } }): Promise<ElicitResult> => {
    console.log('[client] elicitation/create →', request.params.message);
    const content = answers[request.params.message];
    return content === undefined ? { action: 'decline' } : { action: 'accept', content };
};
client.setRequestHandler('elicitation/create', acceptHandler);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Return `input_required` instead of pushing a request" — the round trip the page quotes.
console.log(await client.callTool({ name: 'deploy', arguments: { env: 'prod' } }));

// "Read the responses on re-entry" — the declined branch the page quotes.
client.setRequestHandler('elicitation/create', async (request): Promise<ElicitResult> => {
    console.log('[client] elicitation/create →', request.params.message);
    return { action: 'decline' };
});
console.log(await client.callTool({ name: 'tag-release', arguments: { tag: 'v2.1.0' } }));
client.setRequestHandler('elicitation/create', acceptHandler);

// "Write the handler write-once" — both missing inputs requested in one round.
console.log(await client.callTool({ name: 'provision', arguments: {} }));

// "Carry state across rounds with `requestState`" — two sequential rounds.
console.log(await client.callTool({ name: 'wipe-cache', arguments: {} }));

// "Protect `requestState` with the codec" — tampered state answers -32602.
// Matched by `code`, not `instanceof` (see docs/servers/errors.md): `instanceof`
// fails across separately bundled copies of the SDK.
try {
    await client.request({
        method: 'tools/call',
        params: { name: 'wipe-cache', arguments: {}, requestState: 'tampered' }
    });
} catch (error) {
    const { code, message } = error as ProtocolError;
    if (code !== ProtocolErrorCode.InvalidParams) throw error;
    console.log(`${code} ${message}`);
}

await client.close();
await server.close();
