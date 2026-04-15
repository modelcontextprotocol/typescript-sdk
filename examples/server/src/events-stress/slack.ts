/**
 * Slack — MCP Events server (production-ready).
 *
 * Exposes `slack.message` and `slack.reaction_added` events over MCP using
 * Slack's Socket Mode (outbound WebSocket). One shared WS connection feeds all
 * subscriptions via `server.emitEvent()`. Per-channel `conversations.join` is
 * refcounted across overlapping subscriptions so the bot only joins once and
 * leaves when the last subscriber for a channel unsubscribes. Both events are
 * emit-only: Slack has no REST "list reactions since T" surface, and Socket
 * Mode is the canonical push path for messages. `buffer` makes both
 * visible to poll-mode clients.
 *
 * ## Setup
 *
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Enable Socket Mode (Settings → Socket Mode)
 * 3. Create an App-Level Token with `connections:write` scope → `SLACK_APP_TOKEN`
 * 4. Add Bot Token Scopes (OAuth & Permissions): `channels:history`,
 *    `channels:read`, `channels:join`, `reactions:read`
 * 5. Install to workspace → copy Bot User OAuth Token → `SLACK_BOT_TOKEN`
 * 6. Subscribe to bot events (Event Subscriptions): `message.channels`,
 *    `reaction_added`
 *
 * ## Environment variables
 *
 * | Variable          | Description                                         |
 * |-------------------|-----------------------------------------------------|
 * | `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) for Web API calls |
 * | `SLACK_APP_TOKEN` | App-Level Token (`xapp-...`) for Socket Mode WS     |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/slack.ts
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// --- Slack envelope shapes (SocketModeClient emits untyped `any`) ------------

interface SlackMessageEvent {
    type: 'message';
    channel: string;
    user?: string;
    text?: string;
    ts: string;
    subtype?: string;
}

interface SlackReactionEvent {
    type: 'reaction_added';
    user: string;
    reaction: string;
    item: { type: string; channel: string; ts: string };
    event_ts: string;
}

interface SlackEnvelope {
    ack: () => Promise<void>;
    event: SlackMessageEvent | SlackReactionEvent;
}

// Minimal surface we need from the Slack SDK — lets tests inject a mock.
export interface SlackClients {
    socket: {
        on(event: 'message' | 'reaction_added', handler: (e: SlackEnvelope) => void): void;
        start(): Promise<unknown>;
        disconnect(): Promise<void>;
    };
    web: {
        conversations: {
            join(args: { channel: string }): Promise<unknown>;
            leave(args: { channel: string }): Promise<unknown>;
        };
    };
}

function createRealSlackClients(): SlackClients {
    const appToken = requireEnv('SLACK_APP_TOKEN');
    const botToken = requireEnv('SLACK_BOT_TOKEN');
    return {
        socket: new SocketModeClient({ appToken }),
        web: new WebClient(botToken)
    };
}

// --- server ------------------------------------------------------------------

export function createServer(clients?: SlackClients): McpServer {
    const server = new McpServer({ name: 'slack-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 10_000 } } });

    const slack = clients ?? createRealSlackClients();

    // Refcounting: one shared WS, per-channel join counts.
    let wsRefcount = 0;
    const channelRefcounts = new Map<string, number>();
    const subChannel = new Map<string, string>(); // subscriptionId -> channelId
    let wsStarted: Promise<unknown> | null = null;

    const startSocket = () => {
        // Register handlers once, before the first start(). SocketModeClient
        // dispatches events_api messages by their inner event type.
        slack.socket.on('message', async ({ ack, event }: SlackEnvelope) => {
            await ack();
            if (event.type !== 'message' || event.subtype) return; // skip edits/joins/etc.
            server.emitEvent('slack.message', {
                channelId: event.channel,
                userId: event.user ?? '',
                text: event.text ?? '',
                ts: event.ts
            });
        });
        slack.socket.on('reaction_added', async ({ ack, event }: SlackEnvelope) => {
            await ack();
            if (event.type !== 'reaction_added') return;
            server.emitEvent('slack.reaction_added', {
                channelId: event.item.channel,
                userId: event.user,
                reaction: event.reaction,
                itemTs: event.item.ts
            });
        });
        return slack.socket.start();
    };

    const acquire = async (subId: string, channelId: string) => {
        subChannel.set(subId, channelId);
        if (wsRefcount++ === 0) {
            wsStarted = startSocket();
        }
        await wsStarted;
        const c = (channelRefcounts.get(channelId) ?? 0) + 1;
        channelRefcounts.set(channelId, c);
        if (c === 1) {
            await slack.web.conversations.join({ channel: channelId });
        }
    };

    const release = async (subId: string) => {
        const channelId = subChannel.get(subId);
        if (!channelId) return;
        subChannel.delete(subId);
        const c = (channelRefcounts.get(channelId) ?? 1) - 1;
        if (c === 0) {
            channelRefcounts.delete(channelId);
            await slack.web.conversations.leave({ channel: channelId });
        } else {
            channelRefcounts.set(channelId, c);
        }
        if (--wsRefcount === 0) {
            await slack.socket.disconnect();
            wsStarted = null;
        }
    };

    const channelParam = z.object({
        channelId: z.string().describe('Slack channel ID (C...)')
    });

    // slack.message — emit-only. conversations.history *could* back a real
    // check callback, but Socket Mode is the canonical push path and avoids
    // rate-limit churn for active channels.
    server.registerEvent(
        'slack.message',
        {
            description: 'New message posted in a Slack channel',
            inputSchema: channelParam,
            payloadSchema: z.object({
                channelId: z.string(),
                userId: z.string(),
                text: z.string(),
                ts: z.string()
            }),
            hooks: {
                onSubscribe: (id, { channelId }) => acquire(id, channelId),
                onUnsubscribe: id => release(id)
            },
            matches: (params, data) => params.channelId === data.channelId,
            buffer: { capacity: 500 }
        },
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })
    );

    // slack.reaction_added — PURE emit. No Slack REST endpoint lists reactions
    // since-T, so the check callback has nothing to read. buffer is the
    // *only* thing that makes this event visible to poll clients.
    server.registerEvent(
        'slack.reaction_added',
        {
            description: 'Reaction added to a message in a Slack channel',
            inputSchema: channelParam,
            payloadSchema: z.object({
                channelId: z.string(),
                userId: z.string(),
                reaction: z.string(),
                itemTs: z.string()
            }),
            hooks: {
                onSubscribe: (id, { channelId }) => acquire(id, channelId),
                onUnsubscribe: id => release(id)
            },
            matches: (params, data) => params.channelId === data.channelId,
            buffer: { capacity: 500 }
        },
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })
    );

    return server;
}

// --- main --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('slack MCP server running on stdio');
}
