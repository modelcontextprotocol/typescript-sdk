import { Request, Response } from 'express';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { createMcpExpressApp } from '../../server/express.js';
import { CallToolResult, isInitializeRequest } from '../../types.js';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';

const server = new McpServer(
    { name: 'disconnect-test', version: '1.0.0' },
    { capabilities: { logging: {} } }
);

server.tool('slow-task', 'Task with progress notifications', { steps: z.number() },
    async ({ steps }, extra): Promise<CallToolResult> => {
        for (let i = 1; i <= steps; i++) {
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
    }
);

const app = createMcpExpressApp();
const transports: Record<string, StreamableHTTPServerTransport> = {};

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
        res.on('finish', () => { finished = true; });
        res.on('close', () => {
            if (!finished) {
                console.log('Client disconnected - closing transport to reclaim resources');
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
