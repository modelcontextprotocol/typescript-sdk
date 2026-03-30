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

import { NodeStreamableHTTPServerTransport } from './streamableHttp.js';

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

/**
 * Example: Stateless Streamable HTTP transport (Node.js).
 */
async function NodeStreamableHTTPServerTransport_stateless() {
    //#region NodeStreamableHTTPServerTransport_stateless
    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });
    //#endregion NodeStreamableHTTPServerTransport_stateless
    return transport;
}

// Stubs for Express-style app
declare const app: { post(path: string, handler: (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => void): void };

/**
 * Example: Using with a pre-parsed request body (e.g. Express).
 */
function NodeStreamableHTTPServerTransport_express(transport: NodeStreamableHTTPServerTransport) {
    //#region NodeStreamableHTTPServerTransport_express
    app.post('/mcp', (req, res) => {
        transport.handleRequest(req, res, req.body);
    });
    //#endregion NodeStreamableHTTPServerTransport_express
}
