/**
 * Elicitation — server requests user input. One factory, both protocol eras.
 *
 * The same tools serve both eras with different APIs: on a 2025-era
 * connection (`--legacy`, the `initialize` handshake) the server uses the
 * push-style server→client request flow — `ctx.mcpReq.elicitInput(...)` for
 * form and URL mode, `UrlElicitationRequiredError` for the throw-style URL
 * signal, and `createElicitationCompletionNotifier` for the out-of-band
 * `notifications/elicitation/complete`. On a 2026-07-28 connection there is
 * no server→client request channel: the same tools instead **return**
 * `inputRequired(...)` (multi-round-trip) and the client retries with the
 * collected responses. The protocol carries the request differently; the user
 * experience is the same.
 *
 * One binary, either transport (selected by the shared scaffold from argv).
 */
import { randomUUID } from 'node:crypto';

import type {
    CallToolResult,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    InputRequiredResult,
    McpRequestContext
} from '@modelcontextprotocol/server';
import { acceptedContent, inputRequired, McpServer, UrlElicitationRequiredError } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

// The form schema (with `enumNames` display labels for the enum field).
const REGISTRATION_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        username: { type: 'string', title: 'Username', minLength: 3, maxLength: 20 },
        email: { type: 'string', title: 'Email', format: 'email' },
        plan: {
            type: 'string',
            title: 'Plan',
            enum: ['free', 'pro', 'team'],
            enumNames: ['Free tier', 'Pro', 'Team']
        }
    },
    required: ['username', 'email']
};

type Registration = { username: string; email: string; plan?: string };

function buildServer(reqCtx: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'elicitation-example', version: '1.0.0' });

    // ---- Form-mode elicitation -----------------------------------------------
    server.registerTool(
        'register_user',
        { description: 'Register a new user account by collecting their information' },
        async (ctx): Promise<CallToolResult | InputRequiredResult> => {
            if (reqCtx.era === 'legacy') {
                // 2025-era: push a server→client `elicitation/create` request and
                // await the user's answer in-line.
                const result = await ctx.mcpReq.elicitInput({
                    mode: 'form',
                    message: 'Please provide your registration information:',
                    requestedSchema: REGISTRATION_SCHEMA
                });
                if (result.action !== 'accept' || !result.content) {
                    return { content: [{ type: 'text', text: `registration ${result.action}` }] };
                }
                const { username, email, plan } = result.content as Registration;
                return { content: [{ type: 'text', text: `registered ${username} <${email}> (plan: ${plan ?? 'free'})` }] };
            }
            // 2026-07-28: return inputRequired — the client collects the form
            // and retries this same handler with the response attached.
            const response = ctx.mcpReq.inputResponses?.['form'] as { action?: string } | undefined;
            if (!response) {
                return inputRequired({
                    inputRequests: {
                        form: inputRequired.elicit({
                            message: 'Please provide your registration information:',
                            requestedSchema: REGISTRATION_SCHEMA
                        })
                    }
                });
            }
            const form = acceptedContent<Registration>(ctx.mcpReq.inputResponses, 'form');
            if (!form) {
                return { content: [{ type: 'text', text: `registration ${response.action}` }] };
            }
            return { content: [{ type: 'text', text: `registered ${form.username} <${form.email}> (plan: ${form.plan ?? 'free'})` }] };
        }
    );

    // ---- Multi-step / chained form elicitation (two sequential prompts) ------
    server.registerTool(
        'plan_trip',
        { description: 'Plan a trip by collecting a destination and then dates for that destination' },
        async (ctx): Promise<CallToolResult | InputRequiredResult> => {
            const DEST: ElicitRequestFormParams['requestedSchema'] = {
                type: 'object',
                properties: { destination: { type: 'string', title: 'Destination' } },
                required: ['destination']
            };
            const datesFor = (dest: string): ElicitRequestFormParams['requestedSchema'] => ({
                type: 'object',
                properties: {
                    departure: { type: 'string', title: `Departure date for ${dest}`, format: 'date' },
                    nights: { type: 'integer', title: 'Nights', minimum: 1, maximum: 30 }
                },
                required: ['departure', 'nights']
            });
            if (reqCtx.era === 'legacy') {
                // 2025-era: two sequential `elicitation/create` pushes inside one tool call.
                const step1 = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'Where to?', requestedSchema: DEST });
                if (step1.action !== 'accept' || !step1.content) {
                    return { content: [{ type: 'text', text: `trip ${step1.action}` }] };
                }
                const dest = step1.content.destination as string;
                const step2 = await ctx.mcpReq.elicitInput({ mode: 'form', message: 'When?', requestedSchema: datesFor(dest) });
                if (step2.action !== 'accept' || !step2.content) {
                    return { content: [{ type: 'text', text: `trip ${step2.action}` }] };
                }
                return {
                    content: [
                        { type: 'text', text: `trip planned: ${dest} on ${step2.content.departure} for ${step2.content.nights} nights` }
                    ]
                };
            }
            // 2026-07-28: two `inputRequired` rounds — the second carries the
            // first answer back via `requestState` (an opaque server-minted
            // string) so the chain survives the stateless retry. See ../mrtr/
            // for integrity-protecting `requestState` in production.
            const dates = acceptedContent<{ departure: string; nights: number }>(ctx.mcpReq.inputResponses, 'dates');
            const destination =
                ctx.mcpReq.requestState ?? acceptedContent<{ destination: string }>(ctx.mcpReq.inputResponses, 'dest')?.destination;
            if (!destination) {
                return inputRequired({ inputRequests: { dest: inputRequired.elicit({ message: 'Where to?', requestedSchema: DEST }) } });
            }
            if (!dates) {
                return inputRequired({
                    requestState: destination,
                    inputRequests: { dates: inputRequired.elicit({ message: 'When?', requestedSchema: datesFor(destination) }) }
                });
            }
            return { content: [{ type: 'text', text: `trip planned: ${destination} on ${dates.departure} for ${dates.nights} nights` }] };
        }
    );

    // ---- URL-mode elicitation (push style + completion notification) ---------
    server.registerTool(
        'link_account',
        {
            description: 'Link a third-party account by opening a sign-in URL',
            inputSchema: z.object({ provider: z.string() })
        },
        async ({ provider }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            if (reqCtx.era === 'legacy') {
                // 2025-era push style: send `elicitation/create` (mode: 'url')
                // and, in parallel, simulate the out-of-band callback that
                // fires when the user finishes the URL flow by sending
                // `notifications/elicitation/complete` for the same id. The
                // client waits for that notification before answering accept.
                const elicitationId = randomUUID();
                // Tie the completion notification to the in-flight request so on
                // sessionful HTTP it travels over this POST's SSE response stream
                // (rather than the standalone GET stream).
                const notifyComplete = server.server.createElicitationCompletionNotifier(elicitationId, {
                    relatedRequestId: ctx.mcpReq.id
                });
                setTimeout(() => void notifyComplete().catch(error => console.error('[server] complete notify failed:', error)), 50);
                const params: ElicitRequestURLParams = {
                    mode: 'url',
                    message: `Sign in to ${provider} to link your account`,
                    url: `https://example.com/oauth/${encodeURIComponent(provider)}/authorize`,
                    elicitationId
                };
                const result = await ctx.mcpReq.elicitInput(params);
                return { content: [{ type: 'text', text: result.action === 'accept' ? `linked ${provider}` : `link ${result.action}` }] };
            }
            // 2026-07-28: URL elicitation rides the multi-round-trip flow. No
            // elicitationId / complete notification — correlation is the
            // server's own state across retries.
            const auth = ctx.mcpReq.inputResponses?.['auth'] as { action?: string } | undefined;
            if (auth?.action !== 'accept') {
                return inputRequired({
                    inputRequests: {
                        auth: inputRequired.elicitUrl({
                            message: `Sign in to ${provider} to link your account`,
                            url: `https://example.com/oauth/${encodeURIComponent(provider)}/authorize`
                        })
                    }
                });
            }
            return { content: [{ type: 'text', text: `linked ${provider}` }] };
        }
    );

    // ---- URL-mode elicitation (throw style, 2025-era only) -------------------
    // The error-style signal: the tool THROWS `UrlElicitationRequiredError`
    // (wire `-32042`); the client catches it as a typed error and reads
    // `.elicitations`. There is no 2026-07-28 equivalent — a throw on that era
    // fails loudly with a steer to `inputRequired.elicitUrl(...)`.
    server.registerTool(
        'confirm_payment',
        {
            description: 'Confirm a payment via a browser flow (2025-era throw-style URL elicitation)',
            inputSchema: z.object({ cartId: z.string() })
        },
        async ({ cartId }): Promise<CallToolResult> => {
            throw new UrlElicitationRequiredError([
                {
                    mode: 'url',
                    message: 'Open the link to confirm payment',
                    url: `https://example.com/confirm-payment?cart=${encodeURIComponent(cartId)}`,
                    elicitationId: randomUUID()
                }
            ]);
        }
    );

    return server;
}

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
