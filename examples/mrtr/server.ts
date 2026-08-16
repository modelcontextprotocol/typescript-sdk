/**
 * A write-once tool that requests client input with multi-round-trip results
 * (protocol revision 2026-07-28).
 *
 * The `deploy` tool returns `inputRequired(...)` instead of pushing a
 * server→client request: a form-mode elicitation for confirmation, then a
 * URL-mode elicitation for sign-in via `inputRequired.elicitUrl(...)`. The
 * step the tool is waiting for is carried in `requestState`, which the SDK
 * round-trips opaquely (echoed byte-exact by the client; the handler reads
 * the verified payload back via the typed `ctx.mcpReq.requestState<T>()`
 * accessor).
 *
 * `requestState` round-trips through the client and is therefore
 * attacker-controlled input on re-entry. A real server MUST integrity-protect
 * it (e.g. HMAC or AEAD): this example uses the SDK-provided
 * {@linkcode createRequestStateCodec} helper — `mint` HMAC-seals the payload
 * with a per-process key and a TTL, and `verify` is dropped directly into the
 * {@linkcode ServerOptions.requestState} hook so the seam rejects tampered or
 * expired state with a wire-level `-32602` Invalid Params error before the
 * handler runs.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { acceptedContent, createMcpHandler, createRequestStateCodec, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const CONFIRM_SCHEMA = { type: 'object' as const, properties: { confirm: { type: 'boolean' as const } }, required: ['confirm'] };

type DeployState = { step: 'confirm' | 'signed-in'; env: string };

// Per-process integrity key for requestState. The 2026-07-28 path serves every
// request from a fresh server instance — the state itself is the only thing
// that survives between rounds — so the key is process-local. A multi-instance
// deployment would load a shared secret here instead.
const stateCodec = createRequestStateCodec<DeployState>({
    key: crypto.getRandomValues(new Uint8Array(32)),
    ttlSeconds: 600
});

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'mrtr-example-server', version: '1.0.0' },
        { capabilities: { tools: {} }, requestState: { verify: stateCodec.verify } }
    );

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
            // what (verified) `requestState` was echoed back. The seam-level
            // verify hook has already proven integrity AND decoded the payload
            // by the time the handler runs — the typed accessor returns it.
            const state = ctx.mcpReq.requestState<DeployState>();
            const step = state?.step ?? 'confirm';
            console.error(`[server] tools/call deploy(${env}) step=${step}`);

            if (step === 'confirm') {
                const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
                if (!confirmed?.confirm) {
                    return inputRequired({
                        inputRequests: {
                            confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: CONFIRM_SCHEMA })
                        },
                        // The next entry stays at the 'confirm' step until the
                        // user actually accepts.
                        requestState: await stateCodec.mint({ step: 'confirm', env })
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
                    requestState: await stateCodec.mint({ step: 'signed-in', env })
                });
            }

            // step === 'signed-in': the URL-mode elicitation completed out of
            // band — verify the auth response actually arrived.
            const auth = ctx.mcpReq.inputResponses?.['auth'] as { action?: string } | undefined;
            if (auth?.action !== 'accept') {
                return { isError: true, content: [{ type: 'text', text: 'auth response missing or declined' }] };
            }
            return { content: [{ type: 'text', text: `deployed to ${state?.env ?? env}` }] };
        }
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` binds the endpoint behind localhost host/origin
    // validation by default, matching the framework factories' defaults.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
