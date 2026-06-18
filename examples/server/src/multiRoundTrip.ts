/**
 * A write-once tool served via `createMcpHandler` that requests client input
 * with multi round-trip results (protocol revision 2026-07-28).
 *
 * The `deploy` tool returns `inputRequired(...)` instead of pushing a
 * server→client request: a form-mode elicitation for confirmation, then a
 * URL-mode elicitation for sign-in via `inputRequired.elicitUrl(...)`. The
 * step the tool is waiting for is carried in `requestState`, which the SDK
 * round-trips opaquely (echoed byte-exact by the client; the server reads it
 * raw at `ctx.mcpReq.requestState`).
 *
 * Run with:
 *
 *     tsx examples/server/src/multiRoundTrip.ts
 *
 * and point the paired client example at it:
 *
 *     tsx examples/client/src/multiRoundTripClient.ts
 */
import { createServer } from 'node:http';

import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { acceptedContent, createMcpHandler, inputRequired, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const CONFIRM_SCHEMA = { type: 'object' as const, properties: { confirm: { type: 'boolean' as const } }, required: ['confirm'] };

function buildServer(): McpServer {
    const server = new McpServer({ name: 'mrtr-example-server', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.registerTool(
        'deploy',
        {
            title: 'Deploy (write-once)',
            description: 'Deploys to the named environment after a confirmation and a sign-in.',
            inputSchema: z.object({ env: z.string() })
        },
        async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            // The handler reads the SAME context fields on every entry; what
            // changes between rounds is which input responses have arrived and
            // what `requestState` was echoed back.
            const step = ctx.mcpReq.requestState ?? 'confirm';
            console.error(`[server] tools/call deploy(${env}) step=${step} requestState=${JSON.stringify(ctx.mcpReq.requestState)}`);

            if (step === 'confirm') {
                const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
                if (!confirmed?.confirm) {
                    return inputRequired({
                        inputRequests: {
                            confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: CONFIRM_SCHEMA })
                        },
                        // The next entry stays at the 'confirm' step until the
                        // user actually accepts.
                        requestState: 'confirm'
                    });
                }
                // Move to the URL-mode sign-in step. URL elicitation rides
                // the multi-round-trip flow on this revision — the throw-style
                // UrlElicitationRequiredError of earlier revisions is not
                // available toward 2026-07-28 requests.
                return inputRequired({
                    inputRequests: {
                        auth: inputRequired.elicitUrl({
                            message: 'Sign in to continue',
                            url: `https://example.com/auth?env=${env}`
                        })
                    },
                    requestState: 'signed-in'
                });
            }

            // step === 'signed-in': the URL-mode elicitation completed out of
            // band — verify the auth response actually arrived. requestState is
            // attacker-controlled and trivially replayed; a real server MUST
            // integrity-protect it (e.g. HMAC/AEAD), per the migration guide.
            const auth = ctx.mcpReq.inputResponses?.['auth'] as { action?: string } | undefined;
            if (auth?.action !== 'accept') {
                return { isError: true, content: [{ type: 'text', text: 'auth response missing or declined' }] };
            }
            return { content: [{ type: 'text', text: `deployed to ${env}` }] };
        }
    );

    return server;
}

// Host with the per-request HTTP entry on its default posture (2026-07-28
// served per request; 2025-era traffic served stateless from the same
// factory).
const handler = createMcpHandler(() => buildServer());
const port = Number(process.env.PORT ?? '3000');

createServer((req, res) => void handler.node(req, res)).listen(port, () => {
    console.error(`multi-round-trip example server listening on http://localhost:${port}/`);
});
