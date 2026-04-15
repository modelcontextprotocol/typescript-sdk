/**
 * Discord — MCP Events server (production-ready).
 *
 * Exposes Discord Gateway events as MCP events: new messages, reactions, and
 * member joins. A single shared Gateway WebSocket connection feeds all
 * subscriptions via `server.emitEvent()`; filtering by channel/guild is
 * applied client-side via the `matches` callback. No per-subscription upstream
 * setup is needed — the Gateway delivers all events for guilds the bot has
 * joined once connected.
 *
 * ## Setup
 *
 * 1. Create an application at https://discord.com/developers/applications
 * 2. Bot tab → Reset Token → copy → `DISCORD_BOT_TOKEN`
 * 3. Enable Privileged Gateway Intents: MESSAGE CONTENT, SERVER MEMBERS
 * 4. OAuth2 → URL Generator → scopes: `bot` → permissions: Read Messages,
 *    Read Message History
 * 5. Open the generated URL to add the bot to your server
 * 6. Optional: set `DISCORD_GUILD_ID` to restrict events to one server
 *
 * ## Environment variables
 *
 * | Variable            | Required | Description                                      |
 * |---------------------|----------|--------------------------------------------------|
 * | `DISCORD_BOT_TOKEN` | yes      | Bot token from the Discord developer portal      |
 * | `DISCORD_GUILD_ID`  | no       | If set, ignore events from all other guilds      |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/discord.ts
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { Client as DiscordClient, Events, GatewayIntentBits, Partials } from 'discord.js';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// --- payload schemas ---------------------------------------------------------

const filterSchema = z.object({
    channelId: z.string().optional().describe('Only emit events from this channel'),
    guildId: z.string().optional().describe('Only emit events from this guild (server)')
});
type Filter = z.infer<typeof filterSchema>;

const messagePayload = z.object({
    id: z.string(),
    guildId: z.string().nullable(),
    channelId: z.string(),
    authorId: z.string(),
    authorTag: z.string(),
    content: z.string(),
    createdAt: z.string()
});

const reactionPayload = z.object({
    messageId: z.string(),
    guildId: z.string().nullable(),
    channelId: z.string(),
    userId: z.string(),
    emoji: z.string()
});

const memberPayload = z.object({
    guildId: z.string(),
    userId: z.string(),
    userTag: z.string(),
    joinedAt: z.string().nullable()
});

// --- event helpers -----------------------------------------------------------
// All three events are emit-only: the Gateway has no "list since T" API
// for these streams, so the check callback is a stub and `buffer`
// is the sole path for poll-mode clients.

const matchesChannel = (params: Filter, data: Record<string, unknown>) =>
    (!params.guildId || params.guildId === data.guildId) && (!params.channelId || params.channelId === data.channelId);

const emitOnlyCheck = async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 });

// --- server ------------------------------------------------------------------

export function createServer(discord?: DiscordClient): McpServer {
    const token = discord ? undefined : requireEnv('DISCORD_BOT_TOKEN');
    const guildFilter = process.env.DISCORD_GUILD_ID;

    const client =
        discord ??
        new DiscordClient({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildMessageReactions
            ],
            // Partials let us receive reaction events for uncached messages.
            partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
        });

    const server = new McpServer({ name: 'discord-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 10_000 } } });

    // --- Gateway → emitEvent wiring ---

    client.on(Events.MessageCreate, msg => {
        if (msg.author.bot) return;
        if (guildFilter && msg.guildId !== guildFilter) return;
        server.emitEvent('discord.message_create', {
            id: msg.id,
            guildId: msg.guildId,
            channelId: msg.channelId,
            authorId: msg.author.id,
            authorTag: msg.author.tag,
            content: msg.content,
            createdAt: msg.createdAt.toISOString()
        });
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
        const guildId = reaction.message.guildId;
        if (guildFilter && guildId !== guildFilter) return;
        server.emitEvent('discord.reaction_add', {
            messageId: reaction.message.id,
            guildId,
            channelId: reaction.message.channelId,
            userId: user.id,
            emoji: reaction.emoji.name ?? reaction.emoji.id ?? '<unknown>'
        });
    });

    client.on(Events.GuildMemberAdd, member => {
        if (guildFilter && member.guild.id !== guildFilter) return;
        server.emitEvent('discord.member_join', {
            guildId: member.guild.id,
            userId: member.user.id,
            userTag: member.user.tag,
            joinedAt: member.joinedAt?.toISOString() ?? null
        });
    });

    client.once(Events.ClientReady, c => {
        console.error(`discord gateway ready as ${c.user.tag}`);
    });

    // --- MCP event registrations ---

    server.registerEvent(
        'discord.message_create',
        {
            description: 'A new message was posted in a text channel',
            inputSchema: filterSchema,
            payloadSchema: messagePayload,
            matches: matchesChannel,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    server.registerEvent(
        'discord.reaction_add',
        {
            description: 'A reaction was added to a message',
            inputSchema: filterSchema,
            payloadSchema: reactionPayload,
            matches: matchesChannel,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    server.registerEvent(
        'discord.member_join',
        {
            description: 'A user joined a guild',
            inputSchema: filterSchema.pick({ guildId: true }),
            payloadSchema: memberPayload,
            matches: (params, data) => !params.guildId || params.guildId === data.guildId,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    // --- Lifecycle ---
    // Open the shared Gateway WS now (once per process); close on server.close().
    if (token) {
        client.login(token).catch(error => {
            throw new Error(`discord login failed: ${error}`);
        });
    }

    server.server.onclose = () => {
        void client.destroy();
    };

    return server;
}

// --- main --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('discord MCP server running on stdio');
}
