/**
 * Fully-featured **sessionful** HTTP playground server for the interactive
 * REPL client.
 *
 * Exposes every primitive the REPL client (`./client.ts`) can drive: tools
 * (typed input/output schemas + annotations + form elicitation +
 * `ResourceLink`s), prompts (with `completable()` argument completion),
 * resources (direct + `ResourceTemplate`), `notifications/message` logging,
 * and `notifications/resources/list_changed`.
 *
 * HTTP-only and sessionful by design: hosted on
 * `NodeStreamableHTTPServerTransport` with an in-memory `eventStore` so the
 * REPL client's `reconnect`, `terminate-session`, and
 * `run-notifications-tool-with-resumability` commands actually replay missed
 * events on reconnect with `Last-Event-ID`. The canonical
 * `serveStdio` / `createMcpHandler` arms cannot express that, and the REPL
 * client uses stdin for the readline command loop.
 *
 * Pair with `pnpm run client` in a second terminal.
 */
import { randomUUID } from 'node:crypto';

import { parseExampleArgs } from '@mcp-examples/shared';
import { InMemoryEventStore } from '@mcp-examples/shared/auth';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, PrimitiveSchemaDefinition, ReadResourceResult, ResourceLink } from '@modelcontextprotocol/server';
import { completable, isInitializeRequest, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

/** Dynamic resources added via the `add-resource` tool (shared across sessions). */
const dynamicResources = new Map<string, string>();

function buildServer(): McpServer {
    const server = new McpServer(
        {
            name: 'repl-playground-server',
            version: '1.0.0',
            icons: [{ src: 'https://modelcontextprotocol.io/favicon.svg', sizes: ['any'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
        },
        { capabilities: { logging: {}, resources: { listChanged: true } } }
    );

    // --- Tools -------------------------------------------------------------

    // Typed input + inferred structured output + read-only annotation.
    server.registerTool(
        'greet',
        {
            title: 'Greeting Tool',
            description: 'Returns a greeting for the named subject',
            inputSchema: z.object({ name: z.string().describe('Name to greet') }),
            outputSchema: z.object({ greeting: z.string() }),
            annotations: { readOnlyHint: true, idempotentHint: true }
        },
        async ({ name }) => {
            const structuredContent = { greeting: `Hello, ${name}!` };
            return { content: [{ type: 'text', text: structuredContent.greeting }], structuredContent };
        }
    );

    // Sends `notifications/message` log lines while it runs (drive with `multi-greet`).
    server.registerTool(
        'multi-greet',
        {
            description: 'Sends several greetings with a delay between each, emitting log notifications as it goes',
            inputSchema: z.object({ name: z.string().describe('Name to greet') }),
            annotations: { title: 'Multiple Greeting Tool', readOnlyHint: true, openWorldHint: false }
        },
        async ({ name }, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            await ctx.mcpReq.log('debug', `Starting multi-greet for ${name}`);
            await sleep(500);
            await ctx.mcpReq.log('info', `Sending first greeting to ${name}`);
            await sleep(500);
            await ctx.mcpReq.log('info', `Sending second greeting to ${name}`);
            return { content: [{ type: 'text', text: `Good morning, ${name}!` }] };
        }
    );

    // Form-mode elicitation (drive with the REPL's `collect-info` command).
    server.registerTool(
        'collect-user-info',
        {
            description: 'Collects user information through form elicitation',
            inputSchema: z.object({
                infoType: z.enum(['contact', 'preferences', 'feedback']).describe('Type of information to collect')
            })
        },
        async ({ infoType }, ctx): Promise<CallToolResult> => {
            const schemas: Record<
                string,
                { message: string; schema: { type: 'object'; properties: Record<string, PrimitiveSchemaDefinition>; required?: string[] } }
            > = {
                contact: {
                    message: 'Please provide your contact information',
                    schema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', title: 'Full Name' },
                            email: { type: 'string', title: 'Email Address', format: 'email' }
                        },
                        required: ['name', 'email']
                    }
                },
                preferences: {
                    message: 'Please set your preferences',
                    schema: {
                        type: 'object',
                        properties: {
                            theme: { type: 'string', title: 'Theme', enum: ['light', 'dark', 'auto'] },
                            notifications: { type: 'boolean', title: 'Enable Notifications', default: true }
                        },
                        required: ['theme']
                    }
                },
                feedback: {
                    message: 'Please provide your feedback',
                    schema: {
                        type: 'object',
                        properties: {
                            rating: { type: 'integer', title: 'Rating', minimum: 1, maximum: 5 },
                            comments: { type: 'string', title: 'Comments', maxLength: 500 }
                        },
                        required: ['rating']
                    }
                }
            };
            const picked = schemas[infoType]!;
            const result = await ctx.mcpReq.send({
                method: 'elicitation/create',
                params: { mode: 'form', message: picked.message, requestedSchema: picked.schema }
            });
            if (result.action === 'accept') {
                return { content: [{ type: 'text', text: `Collected ${infoType}: ${JSON.stringify(result.content, null, 2)}` }] };
            }
            return {
                content: [{ type: 'text', text: `User ${result.action === 'decline' ? 'declined' : 'cancelled'} the ${infoType} request.` }]
            };
        }
    );

    // Periodic notifications for testing resumability (`start-notifications` in the REPL).
    server.registerTool(
        'start-notification-stream',
        {
            description: 'Sends periodic log notifications for testing resumability',
            inputSchema: z.object({
                interval: z.number().describe('Interval in ms between notifications').default(1000),
                count: z.number().describe('Number of notifications to send').default(5)
            })
        },
        async ({ interval, count }, ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            for (let i = 1; i <= count; i++) {
                await ctx.mcpReq.log('info', `Periodic notification #${i} at ${new Date().toISOString()}`);
                await sleep(interval);
            }
            return { content: [{ type: 'text', text: `Sent ${count} notifications at ${interval}ms intervals` }] };
        }
    );

    // Mutates the resource set and publishes `resources/list_changed` on this
    // session's standalone SSE stream.
    server.registerTool(
        'add-resource',
        {
            description: 'Add a dynamic note resource and publish resources/list_changed',
            inputSchema: z.object({ name: z.string(), text: z.string() }),
            annotations: { destructiveHint: false }
        },
        async ({ name, text }): Promise<CallToolResult> => {
            dynamicResources.set(name, text);
            server.sendResourceListChanged();
            return { content: [{ type: 'text', text: `Added note://${name}` }] };
        }
    );

    // Returns ResourceLinks (drive with `call-tool list-files`, then `read-resource <uri>`).
    server.registerTool(
        'list-files',
        {
            title: 'List Files with ResourceLinks',
            description: 'Returns a list of files as ResourceLinks without embedding their content',
            inputSchema: z.object({})
        },
        async (): Promise<CallToolResult> => {
            const links: ResourceLink[] = [
                { type: 'resource_link', uri: 'config://app', name: 'App config', mimeType: 'application/json' },
                ...[...dynamicResources.keys()].map(
                    (name): ResourceLink => ({ type: 'resource_link', uri: `note://${name}`, name, mimeType: 'text/plain' })
                )
            ];
            return { content: [{ type: 'text', text: 'Available files:' }, ...links] };
        }
    );

    // --- Prompts (with argument completion) --------------------------------

    const LANGUAGES = ['python', 'typescript', 'rust', 'go'];
    server.registerPrompt(
        'greeting-template',
        {
            title: 'Greeting Template',
            description: 'A simple greeting prompt template',
            argsSchema: z.object({
                name: z.string().describe('Name to include in greeting'),
                language: completable(z.string().describe('Language'), value => LANGUAGES.filter(l => l.startsWith(value)))
            })
        },
        async ({ name, language }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: `Please greet ${name} in ${language}.` } }]
        })
    );

    // --- Resources (direct + template + dynamic) ---------------------------

    server.registerResource(
        'app-config',
        'config://app',
        { title: 'App config', mimeType: 'application/json', description: 'Static application config' },
        async (uri): Promise<ReadResourceResult> => ({
            contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"feature":true}' }]
        })
    );

    server.registerResource(
        'greeting',
        new ResourceTemplate('greeting://{name}', { list: undefined }),
        { description: 'A greeting for the named subject' },
        async (uri, vars): Promise<ReadResourceResult> => ({ contents: [{ uri: uri.href, text: `Hello, ${vars.name}!` }] })
    );

    server.registerResource(
        'note',
        new ResourceTemplate('note://{name}', {
            list: () => ({
                resources: [...dynamicResources.keys()].map(name => ({ uri: `note://${name}`, name, mimeType: 'text/plain' }))
            })
        }),
        { description: 'A dynamic note added via add-resource', mimeType: 'text/plain' },
        async (uri, vars): Promise<ReadResourceResult> => {
            const text = dynamicResources.get(String(vars.name)) ?? '(no such note)';
            return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
        }
    );

    return server;
}

const { port } = parseExampleArgs();

// Sessionful 2025-era hosting with an in-memory event store so the REPL
// client's resumability commands work (reconnect with `Last-Event-ID` replays
// missed `notifications/message` events).
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
const eventStore = new InMemoryEventStore();

const app = createMcpExpressApp();
app.all('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && sessions.has(sid)) {
        await sessions.get(sid)!.handleRequest(req, res, req.body);
    } else if (!sid && isInitializeRequest(req.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore, // resumability — events are persisted for replay on GET reconnect
            // This pair serves one expected handshake: a refused initialize
            // closes the transport (onclose below runs) instead of leaking it.
            closeOnRefusedHandshake: true,
            onsessioninitialized: id => {
                sessions.set(id, transport);
            }
        });
        transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
    } else if (sid) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null });
    }
});

app.listen(port, () => console.error(`[server] REPL playground listening on http://127.0.0.1:${port}/mcp`));

process.on('SIGINT', async () => {
    for (const t of sessions.values()) await t.close();
    process.exit(0);
});
