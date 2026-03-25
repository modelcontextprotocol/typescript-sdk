import { Request, Response } from 'express';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { createMcpExpressApp } from '../../server/express.js';
import { CallToolResult, isInitializeRequest } from '../../types.js';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';

// Usage: npx tsx disconnectTestServer.ts [--abort]
const useAbort = process.argv.includes('--abort');
console.log(`Abort on disconnect: ${useAbort ? 'enabled' : 'disabled'}`);

const server = new McpServer({ name: 'disconnect-test', version: '1.0.0' }, { capabilities: { logging: {} } });

server.server.onerror = err => console.log('[onerror]', err.message);

server.registerTool(
    'slow-task',
    {
        description: 'Task with progress notifications',
        inputSchema: { steps: z.number() }
    },
    async ({ steps }, extra): Promise<CallToolResult> => {
        // SIMULATING A PROXY: create abort controller for "upstream" request
        const abortController = new AbortController();
        if (extra.sessionId) {
            sessionAbortControllers[extra.sessionId] = abortController;
        }

        try {
            for (let i = 1; i <= steps; i++) {
                // Check if aborted before each step
                if (abortController.signal.aborted) {
                    console.log('Upstream request aborted - stopping work');
                    break;
                }

                console.log(`Sending notification ${i}/${steps}`);

                // SIMULATING A PROXY RELAY: onprogress forwards with same progress token
                const progressToken = extra._meta?.progressToken;
                if (progressToken !== undefined) {
                    server.server.notification(
                        {
                            method: 'notifications/progress',
                            params: { progressToken, progress: i, total: steps }
                        },
                        { relatedRequestId: extra.requestId }
                    );
                }

                await new Promise(r => setTimeout(r, 1000));
            }
            return { content: [{ type: 'text', text: 'SUCCESS' }] };
        } finally {
            // Cleanup abort controller
            if (extra.sessionId) {
                delete sessionAbortControllers[extra.sessionId];
            }
        }
    }
);

const app = createMcpExpressApp();
const transports: Record<string, StreamableHTTPServerTransport> = {};
// SIMULATING A PROXY: track abort controllers for upstream requests per session
const sessionAbortControllers: Record<string, AbortController> = {};

app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                console.log(`Session initialized: ${id}`);
                transports[id] = transport!;
            }
        });
        transport.onclose = () => {
            console.log(`Transport closed for session: ${transport!.sessionId}`);
            delete transports[transport!.sessionId!];
        };
        await server.connect(transport);
    }

    if (transport) {
        // Track if response finished normally
        let finished = false;
        res.on('finish', () => {
            finished = true;
        });
        res.on('close', () => {
            if (!finished) {
                console.log('Client disconnected unexpectedly');
                if (useAbort) {
                    // Abort any in-flight upstream requests for this session
                    const abortController = sessionAbortControllers[transport!.sessionId!];
                    if (abortController) {
                        console.log('Aborting upstream request');
                        abortController.abort();
                        delete sessionAbortControllers[transport!.sessionId!];
                    }
                }
                transport!.close();
            }
        });
        await transport.handleRequest(req, res, req.body);
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad request' }, id: null });
    }
});

// Return 405 for GET - we don't support standalone SSE stream
app.get('/mcp', (_req, res) => res.status(405).send('Method not allowed'));

app.listen(3000, () => console.log('Disconnect test server listening on :3000'));
