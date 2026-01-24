/**
 * Simple interactive task server demonstrating elicitation and sampling.
 *
 * This server demonstrates the task message queue pattern from the MCP Tasks spec:
 * - confirm_delete: Uses elicitation to ask the user for confirmation
 * - write_haiku: Uses sampling to request an LLM to generate content
 *
 * Both tools use the "call-now, fetch-later" pattern where the initial call
 * creates a task, and the result is fetched via tasks/result endpoint.
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type {
    CallToolResult,
    CreateMessageRequest,
    CreateMessageResult,
    CreateTaskOptions,
    CreateTaskResult,
    ElicitRequestFormParams,
    ElicitResult,
    GetTaskPayloadResult,
    GetTaskResult,
    JSONRPCRequest,
    PrimitiveSchemaDefinition,
    QueuedMessage,
    QueuedRequest,
    RequestId,
    Result,
    SamplingMessage,
    Task,
    TaskMessageQueue,
    TextContent,
    Tool
} from '@modelcontextprotocol/server';
import {
    CallToolRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    InMemoryTaskStore,
    isTerminal,
    ListToolsRequestSchema,
    RELATED_TASK_META_KEY,
    Server
} from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';

// ============================================================================
// Resolver - Promise-like for passing results between async operations
// ============================================================================

class Resolver<T> {
    private _resolve!: (value: T) => void;
    private _reject!: (error: Error) => void;
    private _promise: Promise<T>;
    private _done = false;

    constructor() {
        this._promise = new Promise<T>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    setResult(value: T): void {
        if (this._done) return;
        this._done = true;
        this._resolve(value);
    }

    setException(error: Error): void {
        if (this._done) return;
        this._done = true;
        this._reject(error);
    }

    wait(): Promise<T> {
        return this._promise;
    }

    done(): boolean {
        return this._done;
    }
}

// ============================================================================
// Extended message queue with resolver support and wait functionality
// ============================================================================

interface QueuedRequestWithResolver extends QueuedRequest {
    resolver?: Resolver<Record<string, unknown>>;
    originalRequestId?: RequestId;
}

type QueuedMessageWithResolver = QueuedRequestWithResolver | QueuedMessage;

class TaskMessageQueueWithResolvers implements TaskMessageQueue {
    private queues = new Map<string, QueuedMessageWithResolver[]>();
    private waitResolvers = new Map<string, (() => void)[]>();

    private getQueue(taskId: string): QueuedMessageWithResolver[] {
        let queue = this.queues.get(taskId);
        if (!queue) {
            queue = [];
            this.queues.set(taskId, queue);
        }
        return queue;
    }

    async enqueue(taskId: string, message: QueuedMessage, _sessionId?: string, maxSize?: number): Promise<void> {
        const queue = this.getQueue(taskId);
        if (maxSize !== undefined && queue.length >= maxSize) {
            throw new Error(`Task message queue overflow: queue size (${queue.length}) exceeds maximum (${maxSize})`);
        }
        queue.push(message);
        // Notify any waiters
        this.notifyWaiters(taskId);
    }

    async enqueueWithResolver(
        taskId: string,
        message: JSONRPCRequest,
        resolver: Resolver<Record<string, unknown>>,
        originalRequestId: RequestId
    ): Promise<void> {
        const queue = this.getQueue(taskId);
        const queuedMessage: QueuedRequestWithResolver = {
            type: 'request',
            message,
            timestamp: Date.now(),
            resolver,
            originalRequestId
        };
        queue.push(queuedMessage);
        this.notifyWaiters(taskId);
    }

    async dequeue(taskId: string, _sessionId?: string): Promise<QueuedMessageWithResolver | undefined> {
        const queue = this.getQueue(taskId);
        return queue.shift();
    }

    async dequeueAll(taskId: string, _sessionId?: string): Promise<QueuedMessageWithResolver[]> {
        const queue = this.queues.get(taskId) ?? [];
        this.queues.delete(taskId);
        return queue;
    }

    async waitForMessage(taskId: string): Promise<void> {
        // Check if there are already messages
        const queue = this.getQueue(taskId);
        if (queue.length > 0) return;

        // Wait for a message to be added
        return new Promise<void>(resolve => {
            let waiters = this.waitResolvers.get(taskId);
            if (!waiters) {
                waiters = [];
                this.waitResolvers.set(taskId, waiters);
            }
            waiters.push(resolve);
        });
    }

    private notifyWaiters(taskId: string): void {
        const waiters = this.waitResolvers.get(taskId);
        if (waiters) {
            this.waitResolvers.delete(taskId);
            for (const resolve of waiters) {
                resolve();
            }
        }
    }

    cleanup(): void {
        this.queues.clear();
        this.waitResolvers.clear();
    }
}

// ============================================================================
// Extended task store with wait functionality
// ============================================================================

class TaskStoreWithNotifications extends InMemoryTaskStore {
    private updateResolvers = new Map<string, (() => void)[]>();

    override async updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void> {
        await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
        this.notifyUpdate(taskId);
    }

    override async storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result, sessionId?: string): Promise<void> {
        await super.storeTaskResult(taskId, status, result, sessionId);
        this.notifyUpdate(taskId);
    }

    async waitForUpdate(taskId: string): Promise<void> {
        return new Promise<void>(resolve => {
            let waiters = this.updateResolvers.get(taskId);
            if (!waiters) {
                waiters = [];
                this.updateResolvers.set(taskId, waiters);
            }
            waiters.push(resolve);
        });
    }

    private notifyUpdate(taskId: string): void {
        const waiters = this.updateResolvers.get(taskId);
        if (waiters) {
            this.updateResolvers.delete(taskId);
            for (const resolve of waiters) {
                resolve();
            }
        }
    }
}

// ============================================================================
// Task Result Handler - delivers queued messages and routes responses
// ============================================================================

class TaskResultHandler {
    private pendingRequests = new Map<RequestId, Resolver<Record<string, unknown>>>();

    constructor(
        private store: TaskStoreWithNotifications,
        private queue: TaskMessageQueueWithResolvers
    ) {}

    async handle(taskId: string, server: Server, _sessionId: string): Promise<Result> {
        while (true) {
            // Get fresh task state
            const task = await this.store.getTask(taskId);
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }

            // Dequeue and send all pending messages
            await this.deliverQueuedMessages(taskId, server, _sessionId);

            // If task is terminal, return result
            if (isTerminal(task.status)) {
                const result = await this.store.getTaskResult(taskId);
                // Add related-task metadata per spec
                return {
                    ...result,
                    _meta: {
                        ...result._meta,
                        [RELATED_TASK_META_KEY]: { taskId }
                    }
                };
            }

            // Wait for task update or new message
            await this.waitForUpdate(taskId);
        }
    }

    private async deliverQueuedMessages(taskId: string, server: Server, _sessionId: string): Promise<void> {
        while (true) {
            const message = await this.queue.dequeue(taskId);
            if (!message) break;

            console.log(`[Server] Delivering queued ${message.type} message for task ${taskId}`);

            if (message.type === 'request') {
                const reqMessage = message as QueuedRequestWithResolver;
                // Send the request via the server
                // Store the resolver so we can route the response back
                if (reqMessage.resolver && reqMessage.originalRequestId) {
                    this.pendingRequests.set(reqMessage.originalRequestId, reqMessage.resolver);
                }

                // Send the message - for elicitation/sampling, we use the server's methods
                // But since we're in tasks/result context, we need to send via transport
                // This is simplified - in production you'd use proper message routing
                try {
                    const request = reqMessage.message;
                    let response: ElicitResult | CreateMessageResult;

                    if (request.method === 'elicitation/create') {
                        // Send elicitation request to client
                        const params = request.params as ElicitRequestFormParams;
                        response = await server.elicitInput(params);
                    } else if (request.method === 'sampling/createMessage') {
                        // Send sampling request to client
                        const params = request.params as CreateMessageRequest['params'];
                        response = await server.createMessage(params);
                    } else {
                        throw new Error(`Unknown request method: ${request.method}`);
                    }

                    // Route response back to resolver
                    if (reqMessage.resolver) {
                        reqMessage.resolver.setResult(response as unknown as Record<string, unknown>);
                    }
                } catch (error) {
                    if (reqMessage.resolver) {
                        reqMessage.resolver.setException(error instanceof Error ? error : new Error(String(error)));
                    }
                }
            }
            // For notifications, we'd send them too but this example focuses on requests
        }
    }

    private async waitForUpdate(taskId: string): Promise<void> {
        // Race between store update and queue message
        await Promise.race([this.store.waitForUpdate(taskId), this.queue.waitForMessage(taskId)]);
    }

    routeResponse(requestId: RequestId, response: Record<string, unknown>): boolean {
        const resolver = this.pendingRequests.get(requestId);
        if (resolver && !resolver.done()) {
            this.pendingRequests.delete(requestId);
            resolver.setResult(response);
            return true;
        }
        return false;
    }

    routeError(requestId: RequestId, error: Error): boolean {
        const resolver = this.pendingRequests.get(requestId);
        if (resolver && !resolver.done()) {
            this.pendingRequests.delete(requestId);
            resolver.setException(error);
            return true;
        }
        return false;
    }
}

// ============================================================================
// Task Session - wraps server to enqueue requests during task execution
// ============================================================================

class TaskSession {
    private requestCounter = 0;

    constructor(
        private server: Server,
        private taskId: string,
        private store: TaskStoreWithNotifications,
        private queue: TaskMessageQueueWithResolvers
    ) {}

    private nextRequestId(): string {
        return `task-${this.taskId}-${++this.requestCounter}`;
    }

    async elicit(
        message: string,
        requestedSchema: {
            type: 'object';
            properties: Record<string, PrimitiveSchemaDefinition>;
            required?: string[];
        }
    ): Promise<{ action: string; content?: Record<string, unknown> }> {
        // Update task status to input_required
        await this.store.updateTaskStatus(this.taskId, 'input_required');

        const requestId = this.nextRequestId();

        // Build the elicitation request with related-task metadata
        const params: ElicitRequestFormParams = {
            message,
            requestedSchema,
            mode: 'form',
            _meta: {
                [RELATED_TASK_META_KEY]: { taskId: this.taskId }
            }
        };

        const jsonrpcRequest: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'elicitation/create',
            params
        };

        // Create resolver to wait for response
        const resolver = new Resolver<Record<string, unknown>>();

        // Enqueue the request
        await this.queue.enqueueWithResolver(this.taskId, jsonrpcRequest, resolver, requestId);

        try {
            // Wait for response
            const response = await resolver.wait();

            // Update status back to working
            await this.store.updateTaskStatus(this.taskId, 'working');

            return response as { action: string; content?: Record<string, unknown> };
        } catch (error) {
            await this.store.updateTaskStatus(this.taskId, 'working');
            throw error;
        }
    }

    async createMessage(
        messages: SamplingMessage[],
        maxTokens: number
    ): Promise<{ role: string; content: TextContent | { type: string } }> {
        // Update task status to input_required
        await this.store.updateTaskStatus(this.taskId, 'input_required');

        const requestId = this.nextRequestId();

        // Build the sampling request with related-task metadata
        const params = {
            messages,
            maxTokens,
            _meta: {
                [RELATED_TASK_META_KEY]: { taskId: this.taskId }
            }
        };

        const jsonrpcRequest: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'sampling/createMessage',
            params
        };

        // Create resolver to wait for response
        const resolver = new Resolver<Record<string, unknown>>();

        // Enqueue the request
        await this.queue.enqueueWithResolver(this.taskId, jsonrpcRequest, resolver, requestId);

        try {
            // Wait for response
            const response = await resolver.wait();

            // Update status back to working
            await this.store.updateTaskStatus(this.taskId, 'working');

            return response as { role: string; content: TextContent | { type: string } };
        } catch (error) {
            await this.store.updateTaskStatus(this.taskId, 'working');
            throw error;
        }
    }
}

// ============================================================================
// Server Setup
// ============================================================================

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8000;

// Create shared stores
const taskStore = new TaskStoreWithNotifications();
const messageQueue = new TaskMessageQueueWithResolvers();
const taskResultHandler = new TaskResultHandler(taskStore, messageQueue);

// Track active task executions
const activeTaskExecutions = new Map<
    string,
    {
        promise: Promise<void>;
        server: Server;
        sessionId: string;
    }
>();

// Create the server
const createServer = (): Server => {
    const server = new Server(
        { name: 'simple-task-interactive', version: '1.0.0' },
        {
            capabilities: {
                tools: {},
                tasks: {
                    requests: {
                        tools: { call: {} }
                    }
                }
            }
        }
    );

    // Register tools
    server.setRequestHandler(ListToolsRequestSchema, async (): Promise<{ tools: Tool[] }> => {
        return {
            tools: [
                {
                    name: 'confirm_delete',
                    description: 'Asks for confirmation before deleting (demonstrates elicitation)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            filename: { type: 'string' }
                        }
                    },
                    execution: { taskSupport: 'required' }
                },
                {
                    name: 'write_haiku',
                    description: 'Asks LLM to write a haiku (demonstrates sampling)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            topic: { type: 'string' }
                        }
                    },
                    execution: { taskSupport: 'required' }
                }
            ]
        };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult | CreateTaskResult> => {
        const { name, arguments: args } = request.params;
        const taskParams = (request.params._meta?.task || request.params.task) as { ttl?: number; pollInterval?: number } | undefined;

        // Validate task mode - these tools require tasks
        if (!taskParams) {
            throw new Error(`Tool ${name} requires task mode`);
        }

        // Create task
        const taskOptions: CreateTaskOptions = {
            ttl: taskParams.ttl,
            pollInterval: taskParams.pollInterval ?? 1000
        };

        const task = await taskStore.createTask(taskOptions, extra.requestId, request, extra.sessionId);

        console.log(`\n[Server] ${name} called, task created: ${task.taskId}`);

        // Start background task execution
        const taskExecution = (async () => {
            try {
                const taskSession = new TaskSession(server, task.taskId, taskStore, messageQueue);

                if (name === 'confirm_delete') {
                    const filename = args?.filename ?? 'unknown.txt';
                    console.log(`[Server] confirm_delete: asking about '${filename}'`);

                    console.log('[Server] Sending elicitation request to client...');
                    const result = await taskSession.elicit(`Are you sure you want to delete '${filename}'?`, {
                        type: 'object',
                        properties: {
                            confirm: { type: 'boolean' }
                        },
                        required: ['confirm']
                    });

                    console.log(
                        `[Server] Received elicitation response: action=${result.action}, content=${JSON.stringify(result.content)}`
                    );

                    let text: string;
                    if (result.action === 'accept' && result.content) {
                        const confirmed = result.content.confirm;
                        text = confirmed ? `Deleted '${filename}'` : 'Deletion cancelled';
                    } else {
                        text = 'Deletion cancelled';
                    }

                    console.log(`[Server] Completing task with result: ${text}`);
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [{ type: 'text', text }]
                    });
                } else if (name === 'write_haiku') {
                    const topic = args?.topic ?? 'nature';
                    console.log(`[Server] write_haiku: topic '${topic}'`);

                    console.log('[Server] Sending sampling request to client...');
                    const result = await taskSession.createMessage(
                        [
                            {
                                role: 'user',
                                content: { type: 'text', text: `Write a haiku about ${topic}` }
                            }
                        ],
                        50
                    );

                    let haiku = 'No response';
                    if (result.content && 'text' in result.content) {
                        haiku = (result.content as TextContent).text;
                    }

                    console.log(`[Server] Received sampling response: ${haiku.slice(0, 50)}...`);
                    console.log('[Server] Completing task with haiku');
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [{ type: 'text', text: `Haiku:\n${haiku}` }]
                    });
                }
            } catch (error) {
                console.error(`[Server] Task ${task.taskId} failed:`, error);
                await taskStore.storeTaskResult(task.taskId, 'failed', {
                    content: [{ type: 'text', text: `Error: ${error}` }],
                    isError: true
                });
            } finally {
                activeTaskExecutions.delete(task.taskId);
            }
        })();

        activeTaskExecutions.set(task.taskId, {
            promise: taskExecution,
            server,
            sessionId: extra.sessionId ?? ''
        });

        return { task };
    });

    // Handle tasks/get
    server.setRequestHandler(GetTaskRequestSchema, async (request): Promise<GetTaskResult> => {
        const { taskId } = request.params;
        const task = await taskStore.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }
        return task;
    });

    // Handle tasks/result
    server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra): Promise<GetTaskPayloadResult> => {
        const { taskId } = request.params;
        console.log(`[Server] tasks/result called for task ${taskId}`);
        return taskResultHandler.handle(taskId, server, extra.sessionId ?? '');
    });

    return server;
};

// ============================================================================
// Express App Setup
// ============================================================================

const app = createMcpExpressApp();

// Map to store transports by session ID
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};

// Helper to check if request is initialize
const isInitializeRequest = (body: unknown): boolean => {
    return typeof body === 'object' && body !== null && 'method' in body && (body as { method: string }).method === 'initialize';
};

// MCP POST endpoint
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
                    console.log(`Session initialized: ${sid}`);
                    transports[sid] = transport;
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Transport closed for session ${sid}`);
                    delete transports[sid];
                }
            };

            const server = createServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Bad Request: No valid session ID' },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

// Handle GET requests for SSE streams
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Session termination request: ${sessionId}`);
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// Start server
app.listen(PORT, () => {
    console.log(`Starting server on http://localhost:${PORT}/mcp`);
    console.log('\nAvailable tools:');
    console.log('  - confirm_delete: Demonstrates elicitation (asks user y/n)');
    console.log('  - write_haiku: Demonstrates sampling (requests LLM completion)');
});

// Handle shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    for (const sessionId of Object.keys(transports)) {
        try {
            await transports[sessionId]!.close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    taskStore.cleanup();
    messageQueue.cleanup();
    console.log('Server shutdown complete');
    process.exit(0);
});
