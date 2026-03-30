/**
 * Type-checked examples for `streamableHttp.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { McpServer } from './mcp.js';
import { WebStandardStreamableHTTPServerTransport } from './streamableHttp.js';

/**
 * Example: Stateful Streamable HTTP transport (Web Standard).
 */
async function WebStandardStreamableHTTPServerTransport_stateful() {
    //#region WebStandardStreamableHTTPServerTransport_stateful
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID()
    });

    await server.connect(transport);
    //#endregion WebStandardStreamableHTTPServerTransport_stateful
}

/**
 * Example: Stateless Streamable HTTP transport (Web Standard).
 */
async function WebStandardStreamableHTTPServerTransport_stateless() {
    //#region WebStandardStreamableHTTPServerTransport_stateless
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });
    //#endregion WebStandardStreamableHTTPServerTransport_stateless
    return transport;
}

// Stubs for framework-specific examples
declare const app: { all(path: string, handler: (c: { req: { raw: Request } }) => Promise<Response>): void };

/**
 * Example: Using with Hono.js.
 */
function WebStandardStreamableHTTPServerTransport_hono(transport: WebStandardStreamableHTTPServerTransport) {
    //#region WebStandardStreamableHTTPServerTransport_hono
    app.all('/mcp', async c => {
        return transport.handleRequest(c.req.raw);
    });
    //#endregion WebStandardStreamableHTTPServerTransport_hono
}

/**
 * Example: Using with Cloudflare Workers.
 */
function WebStandardStreamableHTTPServerTransport_workers(transport: WebStandardStreamableHTTPServerTransport) {
    //#region WebStandardStreamableHTTPServerTransport_workers
    const worker = {
        async fetch(request: Request): Promise<Response> {
            return transport.handleRequest(request);
        }
    };
    //#endregion WebStandardStreamableHTTPServerTransport_workers
    return worker;
}
