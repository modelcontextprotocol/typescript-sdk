/**
 * Drives the multi-round-trip server (`./server.ts`) two ways on a 2026-07-28
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
 * Asserts both flows reach `deployed to …` and exits 0.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import type { CallToolResult, ClientOptions, InputRequiredResult } from '@modelcontextprotocol/client';
import { Client, isInputRequiredResult, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

// Both halves connect identically and differ only in ClientOptions; the
// local helper keeps the SDK transport setup visible in THIS file (the
// canonical shape) while avoiding duplicating it for each half.
const connect = async (options: ClientOptions): Promise<Client> => {
    const client = new Client(
        { name: 'mrtr-example-client', version: '1.0.0' },
        { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' }, ...options }
    );
    await (transport === 'stdio'
        ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
        : client.connect(new StreamableHTTPClientTransport(new URL(url))));
    return client;
};

// --- auto-fulfilment (the default) ---
const auto = await connect({ capabilities: { elicitation: { form: {}, url: {} } } });
// The SAME handler a 2025-flow client registers: the auto-fulfilment
// engine dispatches embedded form and URL elicitations through it.
auto.setRequestHandler('elicitation/create', async request => {
    const params = request.params as { mode?: string; message: string; url?: string };
    if (params.mode === 'url') return { action: 'accept' };
    return { action: 'accept', content: { confirm: true } };
});
// callTool returns a plain CallToolResult — the interactive rounds happen
// inside the call.
const autoResult = await auto.callTool({ name: 'deploy', arguments: { env: 'prod' } });
const autoText = autoResult.content?.[0]?.type === 'text' ? autoResult.content[0].text : '';
check.equal(autoText, 'deployed to prod');
await auto.close();

// --- manual mode (autoFulfill: false + allowInputRequired) ---
const manual = await connect({
    capabilities: { elicitation: { form: {}, url: {} } },
    inputRequired: { autoFulfill: false }
});
let inputResponses: Record<string, unknown> | undefined;
let requestState: string | undefined;
let final: CallToolResult | undefined;
for (let round = 0; round < 10; round++) {
    const value = (await manual.request(
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
        final = value;
        break;
    }
    // Collect responses and echo requestState byte-exact.
    inputResponses = {};
    for (const [key, entry] of Object.entries(value.inputRequests ?? {})) {
        inputResponses[key] = entry.method === 'elicitation/create' ? { action: 'accept', content: { confirm: true } } : {};
    }
    requestState = value.requestState;
}
check.ok(final, 'manual flow should reach a CallToolResult within 10 rounds');
const manualText = final?.content?.[0]?.type === 'text' ? final.content[0].text : '';
check.equal(manualText, 'deployed to staging');
await manual.close();
