/**
 * Local MCP fixture for the cold callTool journey.
 *
 * Speaks the legacy initialize / tools/list / tools/call subset over stdio
 * (newline JSON) or Streamable HTTP JSON responses on 127.0.0.1. No credentials
 * and no calls outside the process.
 *
 * COLD_SCENARIO:
 * - number: pick requires {count:number}; response is {count:1}
 * - label: pick requires {label:string}; response is still {count:1}
 * - changed: first list is number, later lists are label; response stays {count:1}
 * - removed: first list includes pick, later lists do not
 * - notify: number schema, and the first tools/call is followed by tools/list_changed
 *
 * COLD_FILLERS (default 24) adds distinct output schemas that an eager compiler
 * would compile. COLD_BAD=1 adds an uncompilable output schema named "bad".
 * COLD_REPORT, when set, receives the fixture event JSON on shutdown.
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const scenario = process.env.COLD_SCENARIO ?? 'number';
const fillerCount = Number(process.env.COLD_FILLERS ?? '24');
const includeBad = process.env.COLD_BAD === '1';
const reportPath = process.env.COLD_REPORT;
const events = [];

function note(event) {
    events.push({ ...event, at: new Date().toISOString() });
    flushReport();
}

function numberSchema(id) {
    return {
        $id: id,
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        additionalProperties: false
    };
}

function labelSchema(id) {
    return {
        $id: id,
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
        additionalProperties: false
    };
}

function tool(name, outputSchema) {
    return {
        name,
        inputSchema: { type: 'object' },
        ...(outputSchema !== undefined && { outputSchema })
    };
}

function fillers() {
    const tools = [];
    for (let index = 0; index < fillerCount; index += 1) {
        tools.push(tool(`filler-${index}`, numberSchema(`https://example.test/cold/filler-${index}`)));
    }
    return tools;
}

let lists = 0;
let notifyAfterCall = scenario === 'notify';

function catalog() {
    lists += 1;
    const extra = [...fillers(), ...(includeBad ? [tool('bad', { type: 'object', $ref: 'https://example.invalid/missing.json' })] : [])];
    if (scenario === 'removed' && lists > 1) return extra;
    if (scenario === 'label' || (scenario === 'changed' && lists > 1)) {
        return [tool('pick', labelSchema('https://example.test/cold/pick-label')), ...extra];
    }
    return [tool('pick', numberSchema('https://example.test/cold/pick-number')), ...extra];
}

let calls = 0;

function callResult() {
    calls += 1;
    // After tools/list_changed, a payload the previous schema would reject shows
    // whether the client dropped the memoized validator.
    if (scenario === 'notify' && calls > 1) {
        return {
            content: [{ type: 'text', text: 'after-list-changed' }],
            structuredContent: { label: 'after-evict' }
        };
    }
    return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { count: 1 }
    };
}

const sseClients = new Set();

function emitListChanged() {
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
    for (const response of sseClients) {
        response.write(frame);
    }
    note({ kind: 'notify', clients: sseClients.size, transport: process.argv[2] });
}

function replyTo(message, transport, writeNotification) {
    if (!message || message.jsonrpc !== '2.0') return undefined;
    if (message.id === undefined) {
        note({ kind: 'notification', method: message.method, transport });
        return undefined;
    }
    if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion;
        note({ kind: 'initialize', protocolVersion: requested, transport });
        return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: requested,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'cold-output-fixture', version: '1.0.0' }
            }
        };
    }
    if (message.method === 'ping') {
        return { jsonrpc: '2.0', id: message.id, result: {} };
    }
    if (message.method === 'tools/list') {
        const tools = catalog();
        note({ kind: 'list', count: tools.length, names: tools.map(entry => entry.name), transport });
        return { jsonrpc: '2.0', id: message.id, result: { tools, ttlMs: 0 } };
    }
    if (message.method === 'tools/call') {
        const name = message.params?.name;
        note({ kind: 'call', name, transport });
        const response = { jsonrpc: '2.0', id: message.id, result: callResult() };
        if (notifyAfterCall) {
            notifyAfterCall = false;
            writeNotification?.();
        }
        return response;
    }
    note({ kind: 'unknown', method: message.method, transport });
    return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` }
    };
}

function flushReport() {
    if (reportPath === undefined) return;
    writeFileSync(reportPath, JSON.stringify({ scenario, events }, null, 2));
}

process.on('exit', flushReport);

async function serveStdio() {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line);
        let pendingNotify = false;
        const response = replyTo(message, 'stdio', () => {
            pendingNotify = true;
        });
        if (pendingNotify) {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
        }
        if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
}

function serveHttp() {
    const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/mcp') {
            response.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive'
            });
            sseClients.add(response);
            request.on('close', () => sseClients.delete(response));
            return;
        }
        if (request.method === 'DELETE') {
            response.writeHead(405);
            response.end();
            return;
        }
        if (request.method !== 'POST' || request.url !== '/mcp') {
            response.writeHead(404);
            response.end();
            return;
        }
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            let pendingNotify = false;
            const rpc = replyTo(message, 'http', () => {
                pendingNotify = true;
            });
            if (message.id === undefined) {
                response.writeHead(202);
                response.end();
                return;
            }
            if (pendingNotify) emitListChanged();
            const headers = { 'content-type': 'application/json' };
            if (message.method === 'initialize') headers['mcp-session-id'] = 'cold-output';
            response.writeHead(200, headers);
            response.end(JSON.stringify(rpc));
        });
    });
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        process.stderr.write(`COLD_PORT ${address.port}\n`);
    });
}

if (process.argv[2] === 'http') serveHttp();
else if (process.argv[2] === 'stdio') void serveStdio();
else {
    process.stderr.write('usage: cold-output-server.mjs <stdio|http>\n');
    process.exit(1);
}
