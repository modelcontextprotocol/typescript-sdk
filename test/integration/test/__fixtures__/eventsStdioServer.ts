/**
 * An events server: one `EventsExtension` with an emit-only event type
 * (`note.posted`) and a check-function one (`ticket.updated`), plus tools that
 * drive it and report its subscription hooks. Run as a script, it serves over
 * stdio through the dual-era `serveStdio` entry (spawned by
 * `test/events/eventsEndToEnd.test.ts`); that suite also imports
 * {@linkcode eventsFixture} to build the same server in process for its HTTP
 * and in-memory arms.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import type { EmitOnlyEventHandle, EventContext, EventsOptions } from '@modelcontextprotocol/server/ext/events';
import { EventsError, EventsExtension } from '@modelcontextprotocol/server/ext/events';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

export const NOTE = 'note.posted';
export const TICKET = 'ticket.updated';
// The push heartbeat every subscription is granted.
export const HEARTBEAT_MS = 500;
// How many emitted notes the poll and replay buffer keeps.
export const BUFFERED_NOTES = 3;
// How many tickets one check returns; more set `hasMore`.
const TICKET_PAGE = 2;

export interface HookEntry {
    hook: 'subscribe' | 'unsubscribe';
    name: string;
    mode: EventContext['mode'];
    tag: string;
    subscriptionId: string;
}

export interface EventsFixture {
    readonly note: EmitOnlyEventHandle<{ tag: string; text: string }>;
    // Every onSubscribe and onUnsubscribe call, in order.
    readonly log: readonly HookEntry[];
    // A server with the extension, and the tools that drive it.
    server(name: string): McpServer;
}

// Every subscription names a tag, so tests sharing one server see only their own events and hooks.
const TagArgs = z.object({ tag: z.string() });

// Builds the extension with `options` (webhook delivery, a store) on top of the fixture's own.
export function eventsFixture(options: EventsOptions = {}): EventsFixture {
    const events = new EventsExtension({
        heartbeatMs: HEARTBEAT_MS,
        defaultNextPollMs: 50,
        emitBuffer: { maxEvents: BUFFERED_NOTES },
        ...options
    });
    const log: HookEntry[] = [];
    const tickets = new Map<string, string[]>();
    const hooks = {
        onSubscribe: (ctx: EventContext, { tag }: { tag: string }) => {
            log.push({ hook: 'subscribe', name: ctx.name, mode: ctx.mode, tag, subscriptionId: ctx.subscriptionId });
        },
        onUnsubscribe: (ctx: EventContext, { tag }: { tag: string }) => {
            log.push({ hook: 'unsubscribe', name: ctx.name, mode: ctx.mode, tag, subscriptionId: ctx.subscriptionId });
        }
    };
    const note = events.registerEvent(NOTE, {
        emitOnly: true,
        inputSchema: TagArgs,
        payloadSchema: z.object({ tag: z.string(), text: z.string() }),
        match: (_ctx, event, { tag }) => event.data.tag === tag,
        ...hooks
    });
    // The upstream is a list per tag; a cursor is the index of the next ticket.
    const ticket = events.registerEvent(TICKET, {
        inputSchema: TagArgs,
        payloadSchema: z.object({ tag: z.string(), title: z.string() }),
        check: (_ctx, { tag }, cursor) => {
            const upstream = tickets.get(tag) ?? [];
            if (cursor === null) return { events: [], cursor: String(upstream.length) };
            const from = Number(cursor);
            const page = upstream.slice(from, from + TICKET_PAGE);
            const next = from + page.length;
            return {
                events: page.map((title, index) => ({ eventId: `${tag}-${from + index}`, data: { tag, title } })),
                cursor: String(next),
                hasMore: next < upstream.length,
                nextPollMs: 60_000
            };
        },
        ...hooks
    });

    const server = (name: string): McpServer => {
        const mcp = new McpServer({ name, version: '1.0.0' }, { extensions: [events] });
        mcp.registerTool('emit', { inputSchema: z.object({ tag: z.string(), texts: z.array(z.string()) }) }, async ({ tag, texts }) => {
            for (const text of texts) await note.emit({ data: { tag, text } });
            return { content: [] };
        });
        mcp.registerTool('append', { inputSchema: z.object({ tag: z.string(), titles: z.array(z.string()) }) }, ({ tag, titles }) => {
            tickets.set(tag, [...(tickets.get(tag) ?? []), ...titles]);
            return { content: [] };
        });
        mcp.registerTool(
            'terminate',
            { inputSchema: z.object({ name: z.string(), tag: z.string(), mode: z.enum(['poll', 'push']) }) },
            async ({ name, tag, mode }) => {
                const entry = log.findLast(e => e.hook === 'subscribe' && e.name === name && e.tag === tag && e.mode === mode);
                if (entry === undefined) throw new Error(`no ${mode} subscription to ${name} with tag ${tag}`);
                const handle = name === NOTE ? note : ticket;
                await handle.terminate(new EventsError('forbidden', 'Access revoked'), { subscriptionId: entry.subscriptionId });
                return { content: [] };
            }
        );
        mcp.registerTool('hooks', { inputSchema: TagArgs }, ({ tag }) => ({
            content: [{ type: 'text', text: JSON.stringify(log.filter(entry => entry.tag === tag)) }]
        }));
        return mcp;
    };
    return { note, log, server };
}

// Run as a script (not imported): serve one stdio connection.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { server } = eventsFixture();
    const handle = serveStdio(() => server('events-stdio-fixture'));

    const exit = async () => {
        await handle.close();
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0);
    };

    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
}
