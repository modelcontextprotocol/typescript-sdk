/**
 * Type-checked examples for `streamableHttp.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/server';

import { NodeStreamableHTTPServerTransport } from './streamableHttp';

/**
 * Example: Stateful Streamable HTTP transport (Node.js).
 */
async function NodeStreamableHTTPServerTransport_stateful() {
    //#region NodeStreamableHTTPServerTransport_stateful
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
    });

    await server.connect(transport);
    //#endregion NodeStreamableHTTPServerTransport_stateful
}

// Stubs for Node.js request handling examples
declare const incomingRequest: IncomingMessage;
declare const serverResponse: ServerResponse;

/**
 * Example: Stateless Streamable HTTP transport (Node.js).
 */
async function NodeStreamableHTTPServerTransport_stateless() {
    //#region NodeStreamableHTTPServerTransport_stateless
    // A stateless transport serves exactly one request — reuse throws.
    // Construct a fresh transport + server pair per request.
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    await server.connect(transport);
    await transport.handleRequest(incomingRequest, serverResponse);
    //#endregion NodeStreamableHTTPServerTransport_stateless
}

// Stubs for Express-style app
declare const app: { post(path: string, handler: (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => void): void };

/**
 * Example: Using with a pre-parsed request body (e.g. Express).
 */
function NodeStreamableHTTPServerTransport_express() {
    //#region NodeStreamableHTTPServerTransport_express
    app.post('/mcp', async (req, res) => {
        // Stateless serving: a fresh transport + server pair per request.
        const server = new McpServer({ name: 'my-server', version: '1.0.0' });
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });
    //#endregion NodeStreamableHTTPServerTransport_express
}
