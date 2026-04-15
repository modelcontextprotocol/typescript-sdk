/**
 * Example MCP server demonstrating the Events primitive across all three
 * delivery modes (poll, push, webhook).
 *
 * The server exposes two event types:
 *
 * - `counter.tick`: A polled in-memory counter. Every second, the counter
 *   increments. The check callback uses the cursor to track position.
 * - `incident.created`: Driven by direct {@linkcode McpServer.emitEvent | emit()}
 *   calls. Shows broadcast emit with a `matches` filter, plus lifecycle hooks.
 *
 * Run with:
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/eventsExample.ts
 *
 * Optionally enable webhook mode:
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/eventsExample.ts --webhook
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const useWebhook = process.argv.includes('--webhook');

const server = new McpServer(
    {
        name: 'events-example-server',
        version: '1.0.0'
    },
    {
        events: {
            push: {
                heartbeatIntervalMs: 10_000
            },
            webhook: useWebhook
                ? {
                      ttlMs: 5 * 60 * 1000, // 5 minute TTL
                      urlValidation: {
                          allowInsecure: true, // for local testing
                          allowPrivateNetworks: true
                      }
                  }
                : undefined
        }
    }
);

// --- counter.tick: poll-driven check callback ---

let counter = 0;
setInterval(() => {
    counter++;
    // Emit drives push/webhook delivery in real time; bufferEmits below merges
    // these into poll responses too, so all three modes see ticks at 1s cadence.
    server.emitEvent('counter.tick', { value: counter, timestamp: new Date().toISOString() });
}, 1000);

server.registerEvent(
    'counter.tick',
    {
        description: 'Fires every time the in-memory counter is incremented (once per second)',
        inputSchema: z.object({
            minValue: z.number().default(0).describe('Only deliver ticks >= this value'),
            modulo: z.number().int().positive().default(1).describe('Only deliver ticks divisible by this')
        }),
        payloadSchema: z.object({
            value: z.number(),
            timestamp: z.string()
        }),
        matches: (params, data) => {
            const v = (data as { value: number }).value;
            return v >= params.minValue && v % params.modulo === 0;
        },
        bufferEmits: { capacity: 500 }
    },
    async () => ({ events: [], cursor: String(counter), nextPollSeconds: 5 })
);

// --- incident.created: emit-driven with lifecycle hooks ---

const activeIncidentSubscribers = new Set<string>();

server.registerEvent(
    'incident.created',
    {
        description: 'Fires when a (simulated) PagerDuty incident is created',
        inputSchema: z.object({
            severity: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Filter by severity')
        }),
        payloadSchema: z.object({
            incidentId: z.string(),
            title: z.string(),
            severity: z.enum(['P1', 'P2', 'P3', 'P4']),
            service: z.string()
        }),
        hooks: {
            onSubscribe: (id, params) => {
                activeIncidentSubscribers.add(id);
                console.error(`[incidents] subscriber ${id} joined (filter: ${params.severity ?? 'all'})`);
            },
            onUnsubscribe: id => {
                activeIncidentSubscribers.delete(id);
                console.error(`[incidents] subscriber ${id} left`);
            }
        },
        matches: (params, data) => !params.severity || params.severity === data.severity,
        // Buffer broadcast emits so poll-mode clients see them on their next poll.
        bufferEmits: { capacity: 500 }
    },
    // For emit-driven events, the check callback only handles bootstrap.
    // With bufferEmits configured, the SDK merges buffered emits into poll
    // responses — the callback just returns a stable cursor.
    async (_params, _cursor) => ({ events: [], cursor: 'emit-only', nextPollSeconds: 5 })
);

// Simulate incidents arriving from upstream every 15 seconds.
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;
const SERVICES = ['api-gateway', 'auth-service', 'billing-worker', 'search-indexer'] as const;
let incidentCounter = 0;
setInterval(() => {
    if (activeIncidentSubscribers.size === 0) return;
    incidentCounter++;
    const severity = SEVERITIES[Math.floor(Math.random() * SEVERITIES.length)]!;
    const service = SERVICES[Math.floor(Math.random() * SERVICES.length)]!;
    console.error(`[incidents] emitting INC-${incidentCounter} (${severity}, ${service})`);
    server.emitEvent('incident.created', {
        incidentId: `INC-${incidentCounter}`,
        title: `${service} is unhealthy`,
        severity,
        service
    });
}, 15_000);

// --- tool to manually emit an incident (demonstrates targeted emit) ---

server.registerTool(
    'trigger-incident',
    {
        description: 'Manually trigger an incident event (broadcast to all subscribers)',
        inputSchema: z.object({
            title: z.string(),
            severity: z.enum(['P1', 'P2', 'P3', 'P4']),
            service: z.string().default('manual-trigger')
        })
    },
    async ({ title, severity, service }) => {
        incidentCounter++;
        const incidentId = `INC-${incidentCounter}`;
        server.emitEvent('incident.created', { incidentId, title, severity, service });
        return {
            content: [{ type: 'text', text: `Triggered ${incidentId}: ${title} (${severity})` }]
        };
    }
);

// --- stdio transport ---

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Events example server running on stdio');
console.error(`Webhook mode: ${useWebhook ? 'ENABLED' : 'disabled (pass --webhook to enable)'}`);
