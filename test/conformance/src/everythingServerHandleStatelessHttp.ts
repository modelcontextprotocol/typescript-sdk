#!/usr/bin/env node

/**
 * MCP conformance server for the `handleStatelessHttp(createMcpServer)` API.
 *
 * 2026-06 stateless model only: requests lacking required `_meta` are rejected
 * with -32602, GET/DELETE return 405, no per-session instances. Target for
 * conformance #271 server-stateless scenario.
 *
 * Sibling: {@linkcode ./everythingServer.ts} (`transport.connect()` API surface).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { handleStatelessHttp } from '@modelcontextprotocol/server';

import { createMcpServer } from './everythingServerSetup.js';

const handler = handleStatelessHttp(() => createMcpServer({ closeSSEForReconnectTest: ctx => ctx.http?.closeSSE?.() }));

async function bridge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const fetchReq = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
        // @ts-expect-error duplex required for Node fetch with body
        duplex: 'half'
    });
    const fetchRes = await handler(fetchReq);
    res.statusCode = fetchRes.status;
    for (const [k, v] of fetchRes.headers.entries()) res.setHeader(k, v);
    if (fetchRes.body) {
        Readable.fromWeb(fetchRes.body as import('node:stream/web').ReadableStream).pipe(res);
    } else {
        res.end();
    }
}

const PORT = Number(process.env.PORT ?? 3000);
createServer((req, res) => void bridge(req, res).catch(error => console.error('bridge error:', error))).listen(PORT, () => {
    console.log(`MCP Conformance Test Server (handleStatelessHttp) running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
