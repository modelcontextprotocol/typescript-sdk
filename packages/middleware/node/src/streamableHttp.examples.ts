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
import http from 'node:http';

import { McpServer } from '@modelcontextprotocol/server';

import { localhostHostValidation } from './middleware/hostHeaderValidation';
import { localhostOriginValidation } from './middleware/originValidation';
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

/**
 * Example: Unauthenticated Streamable HTTP transport on localhost, with DNS
 * rebinding protection (CVE-2025-66414 / GHSA-w48q-cv73-mx4w).
 *
 * Neither `NodeStreamableHTTPServerTransport` nor a raw `node:http` server
 * validates the `Host`/`Origin` headers on its own — that guard has to be
 * wired in explicitly. Without it, a page in the victim's browser can use
 * DNS rebinding to reach this server and invoke its tools, bypassing the
 * browser's same-origin checks entirely. This is only needed when the
 * server has no other authentication; an authenticated server is not
 * exposed to this attack the same way.
 */
async function NodeStreamableHTTPServerTransport_secure() {
    //#region NodeStreamableHTTPServerTransport_secure
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID()
    });

    await server.connect(transport);

    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    http.createServer((req, res) => {
        if (!validateHost(req, res)) return;
        if (!validateOrigin(req, res)) return;
        void transport.handleRequest(req, res);
    });
    //#endregion NodeStreamableHTTPServerTransport_secure
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
