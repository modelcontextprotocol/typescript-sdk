/**
 * Simple task streaming server demonstrating partial result notifications.
 *
 * This server demonstrates SEP-0000 (Task Streaming — Partial Results):
 * - Registers a tool via `registerToolTask` with `streamPartial: true`
 * - Simulates LLM token generation by emitting partial results at intervals
 * - Uses `createPartialEmitter` for automatic seq management
 *
 * Complete lifecycle:
 *   1. Client calls `tools/call` with task augmentation
 *   2. Server creates a task and returns immediately
 *   3. Background work emits partial notifications (seq 0, 1, 2, ...)
 *   4. Server stores the canonical result and marks the task as completed
 *   5. Client retrieves the final result via `tasks/result`
 *
 * Wire-format trace (JSON-RPC messages on the wire):
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *       "params":{"name":"generate","arguments":{"prompt":"Tell me about TypeScript"},
 *                 "_meta":{"task":{"ttl":60000}}}}
 *
 *   ← {"jsonrpc":"2.0","id":1,"result":{
 *       "task":{"taskId":"<id>","status":"working","ttl":60000,...}}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":"TypeScript"}],"seq":0}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" is"}],"seq":1}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" a"}],"seq":2}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" strongly"}],"seq":3}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" typed"}],"seq":4}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/partial",
 *       "params":{"taskId":"<id>","content":[{"type":"text","text":" language."}],"seq":5}}
 *
 *   ← {"jsonrpc":"2.0","method":"notifications/tasks/status",
 *       "params":{"taskId":"<id>","status":"completed",...}}
 *
 *   → {"jsonrpc":"2.0","id":2,"method":"tasks/result","params":{"taskId":"<id>"}}
 *
 *   ← {"jsonrpc":"2.0","id":2,"result":{
 *       "content":[{"type":"text","text":"TypeScript is a strongly typed language."}],
 *       "isError":false}}
 *
 * Run with: npx tsx examples/server/src/simpleTaskStreaming.ts
 * Then connect with: npx tsx examples/client/src/simpleTaskStreamingClient.ts
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { InMemoryTaskMessageQueue, InMemoryTaskStore, isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8000;

// Shared task store across all sessions
const taskStore = new InMemoryTaskStore();

// ============================================================================
// Simulated LLM token generation
// ============================================================================

/**
 * Simulates an LLM generating tokens one at a time.
 * Returns an array of token strings that, when concatenated, form the full response.
 */
function simulateTokenGeneration(prompt: string): string[] {
    // Simple simulation: split a canned response into word-level tokens
    const responses: Record<string, string> = {
        'Tell me about TypeScript': 'TypeScript is a strongly typed superset of JavaScript that compiles to plain JavaScript.',
        'What is MCP?': 'MCP is the Model Context Protocol, a standard for connecting LLMs to external tools and data.',
        'Explain streaming': 'Streaming allows servers to send incremental results as they become available, improving responsiveness.'
    };

    const fullResponse = responses[prompt] ?? `Here is a response about: ${prompt}. This demonstrates partial result streaming.`;

    // Split into word-level tokens, preserving leading spaces
    return fullResponse
        .split(/(?= )|(?<=^[^ ]+)(?= )/)
        .filter(Boolean)
        .map((word, i) => (i === 0 ? word : word));
}

// ============================================================================
// Server factory
// ============================================================================

function createServer(): McpServer {
    const server = new McpServer(
        { name: 'simple-task-streaming', version: '1.0.0' },
        {
            capabilities: {
                tasks: {
                    requests: { tools: { call: {} } },
                    taskStore,
                    taskMessageQueue: new InMemoryTaskMessageQueue()
                }
            }
        }
    );

    // Register a streaming tool that simulates LLM token generation.
    // `streamPartial: true` automatically declares `tasks.streaming.partial` capability.
    server.experimental.tasks.registerToolTask(
        'generate',
        {
            title: 'Generate Text',
            description: 'Simulates LLM text generation with streaming partial results',
            inputSchema: z.object({
                prompt: z.string().describe('The prompt to generate text for')
            }),
            execution: { taskSupport: 'required', streamPartial: true }
        },
        {
            async createTask({ prompt }, ctx) {
                // Create the task — returned immediately to the client
                const task = await ctx.task.store.createTask({
                    ttl: ctx.task.requestedTtl ?? 60_000,
                    pollInterval: 100
                });

                console.log(`[Server] Task ${task.taskId} created for prompt: "${prompt}"`);

                // Background work: emit partial results then store the canonical result
                (async () => {
                    try {
                        // Small delay to let the client set up its subscription
                        await new Promise(resolve => setTimeout(resolve, 50));

                        // Create a partial emitter with automatic seq management
                        const emitPartial = server.experimental.tasks.createPartialEmitter(task.taskId);

                        // Simulate token-by-token generation
                        const tokens = simulateTokenGeneration(prompt);
                        const allTokens: string[] = [];

                        for (const token of tokens) {
                            allTokens.push(token);
                            console.log(`[Server] Task ${task.taskId} partial seq=${allTokens.length - 1}: "${token}"`);

                            // Emit each token as a partial notification
                            await emitPartial([{ type: 'text', text: token }]);

                            // Simulate generation latency (50–150ms per token)
                            await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
                        }

                        // Store the canonical result — the complete text
                        const fullText = allTokens.join('');
                        console.log(`[Server] Task ${task.taskId} completed: "${fullText}"`);

                        await ctx.task.store.storeTaskResult(task.taskId, 'completed', {
                            content: [{ type: 'text', text: fullText }]
                        });
                    } catch (error) {
                        console.error(`[Server] Task ${task.taskId} failed:`, error);
                        await ctx.task.store.storeTaskResult(task.taskId, 'failed', {
                            content: [{ type: 'text', text: `Error: ${error}` }],
                            isError: true
                        });
                    }
                })();

                return { task };
            },

            async getTask(_args, ctx) {
                const task = await ctx.task.store.getTask(ctx.task.id);
                if (!task) throw new Error(`Task ${ctx.task.id} not found`);
                return task;
            },

            async getTaskResult(_args, ctx) {
                const result = await ctx.task.store.getTaskResult(ctx.task.id);
                return result as CallToolResult;
            }
        }
    );

    return server;
}

// ============================================================================
// Express app setup
// ============================================================================

const app = createMcpExpressApp();

const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sid => {
                    console.log(`[Server] Session initialized: ${sid}`);
                    transports[sid] = transport;
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`[Server] Session closed: ${sid}`);
                    delete transports[sid];
                }
            };

            const server = createServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else if (sessionId) {
            res.status(404).json({
                jsonrpc: '2.0',
                error: { code: -32_001, message: 'Session not found' },
                id: null
            });
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Bad Request: Session ID required' },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('[Server] Error handling request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Missing or invalid session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Missing or invalid session ID');
        return;
    }
    console.log(`[Server] Session termination: ${sessionId}`);
    await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, () => {
    console.log(`[Server] Task streaming server running at http://localhost:${PORT}/mcp`);
    console.log('[Server] Tool: generate — simulates LLM token generation with partial results');
    console.log('[Server] Connect with: npx tsx examples/client/src/simpleTaskStreamingClient.ts');
});

process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    for (const sid of Object.keys(transports)) {
        try {
            await transports[sid]!.close();
            delete transports[sid];
        } catch {
            // ignore cleanup errors
        }
    }
    process.exit(0);
});
