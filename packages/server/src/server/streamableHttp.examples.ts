/**
 * Type-checked examples for `streamableHttp.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { McpServer } from './mcp';
import { WebStandardStreamableHTTPServerTransport } from './streamableHttp';

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
async function WebStandardStreamableHTTPServerTransport_stateless(request: Request) {
    //#region WebStandardStreamableHTTPServerTransport_stateless
    // A stateless transport serves exactly one request — reuse throws.
    // Construct a fresh transport + server pair per request.
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    //#endregion WebStandardStreamableHTTPServerTransport_stateless
    return response;
}

// Stubs for framework-specific examples
declare const app: { all(path: string, handler: (c: { req: { raw: Request } }) => Promise<Response>): void };

/**
 * Example: Using with Hono.js.
 */
function WebStandardStreamableHTTPServerTransport_hono() {
    //#region WebStandardStreamableHTTPServerTransport_hono
    app.all('/mcp', async c => {
        // Stateless serving: a fresh transport + server pair per request.
        const server = new McpServer({ name: 'my-server', version: '1.0.0' });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        return transport.handleRequest(c.req.raw);
    });
    //#endregion WebStandardStreamableHTTPServerTransport_hono
}

/**
 * Example: Using with Cloudflare Workers.
 */
function WebStandardStreamableHTTPServerTransport_workers() {
    //#region WebStandardStreamableHTTPServerTransport_workers
    const worker = {
        async fetch(request: Request): Promise<Response> {
            // Stateless serving: a fresh transport + server pair per request.
            const server = new McpServer({ name: 'my-server', version: '1.0.0' });
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            return transport.handleRequest(request);
        }
    };
    //#endregion WebStandardStreamableHTTPServerTransport_workers
    return worker;
}
