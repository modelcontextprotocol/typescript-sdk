"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SSE Polling Example Server (SEP-1699)
 *
 * This example demonstrates server-initiated SSE stream disconnection
 * and client reconnection with Last-Event-ID for resumability.
 *
 * Key features:
 * - Configures `retryInterval` to tell clients how long to wait before reconnecting
 * - Uses `eventStore` to persist events for replay after reconnection
 * - Calls `closeSSEStream()` to gracefully disconnect clients mid-operation
 *
 * Run with: npx tsx src/examples/server/ssePollingExample.ts
 * Test with: curl or the MCP Inspector
 */
const express_1 = __importDefault(require("express"));
const node_crypto_1 = require("node:crypto");
const mcp_js_1 = require("../../server/mcp.js");
const streamableHttp_js_1 = require("../../server/streamableHttp.js");
const inMemoryEventStore_js_1 = require("../shared/inMemoryEventStore.js");
const cors_1 = __importDefault(require("cors"));
// Create the MCP server
const server = new mcp_js_1.McpServer({
    name: 'sse-polling-example',
    version: '1.0.0'
}, {
    capabilities: { logging: {} }
});
// Track active transports by session ID for closeSSEStream access
const transports = new Map();
// Register a long-running tool that demonstrates server-initiated disconnect
server.tool('long-task', 'A long-running task that sends progress updates. Server will disconnect mid-task to demonstrate polling.', {}, async (_args, extra) => {
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    console.log(`[${extra.sessionId}] Starting long-task...`);
    // Send first progress notification
    await server.sendLoggingMessage({
        level: 'info',
        data: 'Progress: 25% - Starting work...'
    }, extra.sessionId);
    await sleep(1000);
    // Send second progress notification
    await server.sendLoggingMessage({
        level: 'info',
        data: 'Progress: 50% - Halfway there...'
    }, extra.sessionId);
    await sleep(1000);
    // Server decides to disconnect the client to free resources
    // Client will reconnect via GET with Last-Event-ID after retryInterval
    const transport = transports.get(extra.sessionId);
    if (transport) {
        console.log(`[${extra.sessionId}] Closing SSE stream to trigger client polling...`);
        transport.closeSSEStream(extra.requestId);
    }
    // Continue processing while client is disconnected
    // Events are stored in eventStore and will be replayed on reconnect
    await sleep(500);
    await server.sendLoggingMessage({
        level: 'info',
        data: 'Progress: 75% - Almost done (sent while client disconnected)...'
    }, extra.sessionId);
    await sleep(500);
    await server.sendLoggingMessage({
        level: 'info',
        data: 'Progress: 100% - Complete!'
    }, extra.sessionId);
    console.log(`[${extra.sessionId}] Task complete`);
    return {
        content: [
            {
                type: 'text',
                text: 'Long task completed successfully!'
            }
        ]
    };
});
// Set up Express app
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
// Create event store for resumability
const eventStore = new inMemoryEventStore_js_1.InMemoryEventStore();
// Handle all MCP requests - use express.json() only for this route
app.all('/mcp', express_1.default.json(), async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    // Reuse existing transport or create new one
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
        transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: () => (0, node_crypto_1.randomUUID)(),
            eventStore,
            retryInterval: 2000, // Client should reconnect after 2 seconds
            onsessioninitialized: id => {
                console.log(`[${id}] Session initialized`);
                transports.set(id, transport);
            }
        });
        // Connect the MCP server to the transport
        await server.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
});
// Start the server
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`SSE Polling Example Server running on http://localhost:${PORT}/mcp`);
    console.log('');
    console.log('This server demonstrates SEP-1699 SSE polling:');
    console.log('- retryInterval: 2000ms (client waits 2s before reconnecting)');
    console.log('- eventStore: InMemoryEventStore (events are persisted for replay)');
    console.log('');
    console.log('Try calling the "long-task" tool to see server-initiated disconnect in action.');
});
//# sourceMappingURL=ssePollingExample.js.map