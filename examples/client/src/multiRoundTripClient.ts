/**
 * Drives the multi-round-trip server example
 * (`examples/server/src/multiRoundTrip.ts`) two ways on a 2026-07-28
 * connection:
 *
 * 1. **auto-fulfilment** (the default) — the same `elicitation/create`
 *    handler the client would register for the 2025-era flow fulfils the
 *    embedded form and URL elicitations, and the SDK retries the original
 *    `tools/call` for you. `client.callTool()` returns a plain
 *    `CallToolResult`;
 * 2. **manual mode** — `inputRequired: { autoFulfill: false }` plus per-call
 *    `allowInputRequired: true`: the input-required value is handed back, and
 *    the example collects responses, echoes `requestState`, and retries
 *    itself.
 *
 * Start the server first, then:
 *
 *     tsx examples/client/src/multiRoundTripClient.ts
 */
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/client';
import { Client, isInputRequiredResult, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const URL = process.env.MCP_SERVER_URL ?? 'http://localhost:3000/';
const CLIENT_INFO = { name: 'mrtr-example-client', version: '1.0.0' };

async function autoFulfilLeg(): Promise<void> {
    console.log('--- auto-fulfilment (the default) ---');
    const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: 'auto' },
        capabilities: { elicitation: { form: {}, url: {} } }
    });
    // The SAME handler a 2025-flow client registers: the auto-fulfilment
    // engine dispatches embedded form and URL elicitations through it.
    client.setRequestHandler('elicitation/create', async request => {
        const params = request.params as { mode?: string; message: string; url?: string };
        if (params.mode === 'url') {
            console.log(`[client] (auto) url elicitation: ${params.message} → ${params.url}`);
            return { action: 'accept' };
        }
        console.log(`[client] (auto) form elicitation: ${params.message}`);
        return { action: 'accept', content: { confirm: true } };
    });

    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    console.log('negotiated protocol version:', client.getNegotiatedProtocolVersion());

    // callTool returns a plain CallToolResult — the interactive rounds happen
    // inside the call.
    const result = await client.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    console.log('deploy result:', JSON.stringify(result.content));
    await client.close();
}

async function manualLeg(): Promise<void> {
    console.log('--- manual mode (autoFulfill: false + allowInputRequired) ---');
    const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: 'auto' },
        capabilities: { elicitation: { form: {}, url: {} } },
        inputRequired: { autoFulfill: false }
    });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));

    let inputResponses: Record<string, unknown> | undefined;
    let requestState: string | undefined;
    for (let round = 0; round < 10; round++) {
        // allowInputRequired: true → the call resolves with either the
        // complete CallToolResult or the input-required value (use
        // `withInputRequired(schema)` on the explicit-schema path to type
        // both outcomes; here the method-keyed path is used for brevity).
        const value = (await client.request(
            {
                method: 'tools/call',
                params: {
                    name: 'deploy',
                    arguments: { env: 'staging' },
                    ...(inputResponses && { inputResponses }),
                    ...(requestState && { requestState })
                }
            },
            { allowInputRequired: true }
        )) as CallToolResult | InputRequiredResult;
        if (!isInputRequiredResult(value)) {
            console.log('deploy result:', JSON.stringify(value.content));
            break;
        }
        // Collect responses and echo requestState byte-exact.
        console.log(`[client] (manual) round ${round + 1}: server asked for ${Object.keys(value.inputRequests ?? {}).join(', ')}`);
        inputResponses = {};
        for (const [key, entry] of Object.entries(value.inputRequests ?? {})) {
            inputResponses[key] = entry.method === 'elicitation/create' ? { action: 'accept', content: { confirm: true } } : {};
        }
        requestState = value.requestState;
    }
    await client.close();
}

await autoFulfilLeg();
await manualLeg();
