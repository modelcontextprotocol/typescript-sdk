#!/usr/bin/env node

/**
 * MCP conformance server — `handleHttp()` API path.
 *
 * One shared {@linkcode McpServer} driven by `handleHttp(mcp, { session, eventStore })`
 * (which mounts the internal `shttpHandler`) and adapted to express via `toNodeHttpHandler`.
 * No transport class, no per-session server map. Registrations from
 * {@linkcode ./everythingServerSetup.ts}.
 *
 * Sibling: {@linkcode ./everythingServer.ts} drives the same registrations via the
 * `transport.connect()` API surface so CI proves both API surfaces stay conformant.
 */

import { localhostHostValidation } from '@modelcontextprotocol/express';
import { toNodeHttpHandler } from '@modelcontextprotocol/node';
import { BackchannelCompat, handleHttp, SessionCompat } from '@modelcontextprotocol/server';
import cors from 'cors';
import express from 'express';

import { createEventStore, createMcpServer } from './everythingServerSetup.js';

const mcp = createMcpServer({
    closeSSEForReconnectTest: ctx => ctx.http?.closeSSE?.()
});

const backchannel = new BackchannelCompat();
const handler = toNodeHttpHandler(
    handleHttp(mcp, {
        session: new SessionCompat({
            onsessioninitialized: sid => console.log(`Session initialized with ID: ${sid}`),
            onsessionclosed: sid => {
                console.log(`Session ${sid} closed`);
                backchannel.closeSession(sid);
            }
        }),
        backchannel,
        eventStore: createEventStore(),
        retryInterval: 5000,
        onerror: err => console.error('handleHttp error:', err)
    })
);

const app = express();
app.use(localhostHostValidation());
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
    })
);
app.all('/mcp', handler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server (handleHttp path) running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
