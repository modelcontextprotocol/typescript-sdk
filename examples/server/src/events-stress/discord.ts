/**
 * Discord — MCP Events server (production-ready, multi-tenant authz).
 *
 * Exposes Discord Gateway events (messages, reactions, member joins) as MCP
 * events and gates delivery on the **subscribing user's** Discord permissions,
 * not just the bot's. This is the pattern a hosted multi-tenant Discord MCP
 * service would use: one Gateway connection per bot-install, fan out per
 * subscriber subject to that subscriber's own guild/channel access.
 *
 * ## Authz model
 *
 * 1. On subscribe, `onSubscribe` resolves the MCP principal to a Discord user
 *    access token (via {@linkcode UserTokenStore}) and checks that the user
 *    is in the requested guild / can read the requested channel.
 * 2. On each incoming Gateway event, the server broadcasts via
 *    `emitEvent(name, data)` (no `subscriptionId`). Broadcasts enter the
 *    SDK's unified event log, so `--from <cursor>` replay works for free.
 * 3. The event's async `matches(params, data, {subscriptionId})` hook is the
 *    per-delivery gate: it `await`s an authz check against the event's
 *    actual guild/channel before approving delivery. First call per channel
 *    hits Discord (~1 API round-trip); subsequent calls hit the cache and
 *    resolve without I/O. A guild-scoped sub legitimately receives events
 *    from many channels — events from channels the user can't read are
 *    silently dropped, the sub stays alive.
 * 4. Stale window: up to the cache TTL (60s) between an upstream permission
 *    change and the next refresh that observes it. There are no gateway
 *    revocation watchers — cache entries self-expire and the next event on
 *    a channel triggers re-evaluation after expiry.
 *
 * In stdio mode there is no HTTP auth, so the "principal" falls back to the
 * MCP session id; a real deployment uses an HTTP transport with OAuth so that
 * `ctx.http.authInfo.clientId` carries a stable per-user identity.
 *
 * ## Setup
 *
 * 1. Create an application at https://discord.com/developers/applications
 * 2. Bot tab → Reset Token → copy → `DISCORD_BOT_TOKEN`
 * 3. Enable Privileged Gateway Intents: MESSAGE CONTENT, SERVER MEMBERS
 * 4. OAuth2 → URL Generator → scopes: `bot` → permissions: Read Messages,
 *    Read Message History
 * 5. Open the generated URL to add the bot to your server
 * 6. For demo purposes, seed `DEMO_USER_TOKENS` with a JSON object mapping
 *    each MCP principal (stdio: session id; HTTP: OAuth clientId) to that
 *    user's Discord access token (`Bearer <token>` or raw token string).
 *    In production this is replaced by a real Discord OAuth flow wired to
 *    MCP auth middleware — the same principal key, a real token provider.
 *
 * ## Environment variables
 *
 * | Variable            | Required | Description                                      |
 * |---------------------|----------|--------------------------------------------------|
 * | `DISCORD_BOT_TOKEN` | yes      | Bot token from the Discord developer portal      |
 * | `DISCORD_GUILD_ID`  | no       | If set, ignore events from all other guilds      |
 * | `DEMO_USER_TOKENS`  | demo     | JSON `{ "<principal>": "<user access token>" }`  |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/discord.ts
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/core';
import { EVENT_UNAUTHORIZED, TOO_MANY_SUBSCRIPTIONS, ProtocolError } from '@modelcontextprotocol/core';
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

// Base filter; authz-aware version is built in createServer() (needs authz + server).
const filterMatches = (params: Filter, data: Record<string, unknown>) =>
    (!params.guildId || params.guildId === data.guildId) && (!params.channelId || params.channelId === data.channelId);

const emitOnlyCheck = async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 });

// --- authz primitives --------------------------------------------------------

// Discord permission bits (bigint; Discord returns them as strings).
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_READ_MESSAGE_HISTORY = 1n << 16n;

/** Size caps prevent DoS via unique-key spraying (subscriber-controlled inputs). */
const MAX_CACHE_ENTRIES = 10_000;
const MAX_SUBS_PER_PRINCIPAL = 100;
const MAX_TOTAL_SUBS = 10_000;

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

/**
 * Bounded TTL cache. Plain {@linkcode Map} retains insertion order, so when
 * adding past the size cap we evict the oldest entry to guard against
 * subscriber-controlled keys (channelId, principal) growing the map forever.
 */
class TtlCache<T> {
    private _store = new Map<string, CacheEntry<T>>();
    constructor(
        private readonly _ttlMs: number,
        private readonly _maxEntries: number = MAX_CACHE_ENTRIES
    ) {}
    get(key: string): T | undefined {
        const hit = this._store.get(key);
        if (!hit) return undefined;
        if (hit.expiresAt < Date.now()) {
            this._store.delete(key);
            return undefined;
        }
        return hit.value;
    }
    set(key: string, value: T): void {
        if (this._store.has(key)) this._store.delete(key);
        this._store.set(key, { value, expiresAt: Date.now() + this._ttlMs });
        while (this._store.size > this._maxEntries) {
            const oldest = this._store.keys().next().value;
            if (oldest === undefined) break;
            this._store.delete(oldest);
        }
    }
    invalidate(key: string): void {
        this._store.delete(key);
    }
    invalidatePrefix(prefix: string): void {
        for (const k of this._store.keys()) if (k.startsWith(prefix)) this._store.delete(k);
    }
}

/**
 * Demo-only token source. Maps MCP principal (stable per-user identity) →
 * Discord user access token. In production this wraps an OAuth store; the
 * interface is the same so downstream code is unchanged.
 */
class UserTokenStore {
    private readonly _tokens: Map<string, string>;
    constructor(raw: string | undefined) {
        this._tokens = new Map();
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) this._tokens.set(k, v);
    }
    get(principal: string): string | undefined {
        return this._tokens.get(principal);
    }
}

interface DiscordGuild {
    id: string;
}

interface DiscordRole {
    id: string;
    permissions: string;
}

interface DiscordChannelOverwrite {
    id: string;
    /** 0 = role, 1 = member. */
    type: 0 | 1;
    allow: string;
    deny: string;
}

interface DiscordChannel {
    id: string;
    guild_id?: string;
    permission_overwrites?: DiscordChannelOverwrite[];
}

interface DiscordMember {
    user?: { id: string };
    roles: string[];
}

/** Thin wrapper over the two Discord REST endpoints we need. */
class DiscordApi {
    constructor(private readonly _botToken: string) {}

    private async _call<T>(path: string, auth: string): Promise<T> {
        const res = await fetch(`https://discord.com/api/v10${path}`, {
            headers: { Authorization: auth }
        });
        if (!res.ok) throw new Error(`discord ${path} ${res.status}`);
        return (await res.json()) as T;
    }

    async listUserGuilds(userToken: string): Promise<DiscordGuild[]> {
        const auth = userToken.startsWith('Bearer ') ? userToken : `Bearer ${userToken}`;
        return this._call<DiscordGuild[]>('/users/@me/guilds', auth);
    }

    /**
     * Compute effective permission bits for `userId` in `channelId` using bot
     * credentials. See https://discord.com/developers/docs/topics/permissions.
     */
    /**
     * Compute effective permission bits for `userId` across every channel in
     * `guildId` using bot credentials. Issues three Discord API calls total
     * (channels, member, roles) regardless of guild size, then computes each
     * channel's perms locally from the inline overwrites. Useful for priming
     * a per-(principal,channel) cache at subscribe time.
     */
    async getGuildChannelPermsForUser(guildId: string, userId: string): Promise<Map<string, bigint>> {
        const botAuth = `Bot ${this._botToken}`;
        const [channels, member, roles] = await Promise.all([
            this._call<DiscordChannel[]>(`/guilds/${guildId}/channels`, botAuth),
            this._call<DiscordMember>(`/guilds/${guildId}/members/${userId}`, botAuth),
            this._call<DiscordRole[]>(`/guilds/${guildId}/roles`, botAuth)
        ]);
        const out = new Map<string, bigint>();
        for (const channel of channels) {
            out.set(channel.id, this._computePerms(channel, guildId, member, roles, userId));
        }
        return out;
    }

    private _computePerms(
        channel: DiscordChannel,
        guildId: string,
        member: DiscordMember,
        roles: DiscordRole[],
        userId: string
    ): bigint {
        const roleById = new Map(roles.map(r => [r.id, r]));
        const everyone = roleById.get(guildId);
        let base = everyone ? BigInt(everyone.permissions) : 0n;
        for (const roleId of member.roles) {
            const role = roleById.get(roleId);
            if (role) base |= BigInt(role.permissions);
        }
        if (base & PERM_ADMINISTRATOR) return ~0n;
        const overwrites = channel.permission_overwrites ?? [];
        const everyoneOw = overwrites.find(o => o.id === guildId);
        if (everyoneOw) {
            base &= ~BigInt(everyoneOw.deny);
            base |= BigInt(everyoneOw.allow);
        }
        let roleDeny = 0n;
        let roleAllow = 0n;
        for (const ow of overwrites) {
            if (ow.type === 0 && ow.id !== guildId && member.roles.includes(ow.id)) {
                roleDeny |= BigInt(ow.deny);
                roleAllow |= BigInt(ow.allow);
            }
        }
        base &= ~roleDeny;
        base |= roleAllow;
        const memberOw = overwrites.find(o => o.type === 1 && o.id === userId);
        if (memberOw) {
            base &= ~BigInt(memberOw.deny);
            base |= BigInt(memberOw.allow);
        }
        return base;
    }

    async getChannelPermsForUser(channelId: string, userId: string): Promise<bigint> {
        const botAuth = `Bot ${this._botToken}`;
        const channel = await this._call<DiscordChannel>(`/channels/${channelId}`, botAuth);
        if (!channel.guild_id) return 0n;
        const guildId = channel.guild_id;
        const [member, roles] = await Promise.all([
            this._call<DiscordMember>(`/guilds/${guildId}/members/${userId}`, botAuth),
            this._call<DiscordRole[]>(`/guilds/${guildId}/roles`, botAuth)
        ]);
        return this._computePerms(channel, guildId, member, roles, userId);
    }
}

/** Per-subscription authz context, populated in onSubscribe. */
interface SubAuthzEntry {
    principal: string;
    guildId?: string;
    channelId?: string;
}

/**
 * Authz coordinator: token store + API client + permission cache + per-sub
 * lookup table. Owns revocation on upstream change events.
 */
class Authz {
    private readonly _guildCache = new TtlCache<Set<string>>(60_000);
    private readonly _permCache = new TtlCache<bigint>(60_000);
    /** `subscriptionId → entry`. Bounded to prevent subscribe-flood DoS. */
    private readonly _subs = new Map<string, SubAuthzEntry>();
    /** `principal → count of active subs`. */
    private readonly _subsByPrincipal = new Map<string, number>();

    constructor(
        private readonly _tokens: UserTokenStore,
        private readonly _api: DiscordApi
    ) {}

    static principalFor(ctx: ServerContext): string {
        return ctx.http?.authInfo?.clientId ?? ctx.sessionId ?? 'stdio-anonymous';
    }

    /** Throws on denial. Called from `onSubscribe`. */
    async authorise(subId: string, params: Filter, ctx: ServerContext): Promise<void> {
        const principal = Authz.principalFor(ctx);
        if (this._subs.size >= MAX_TOTAL_SUBS) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, 'server subscription capacity exceeded');
        }
        if ((this._subsByPrincipal.get(principal) ?? 0) >= MAX_SUBS_PER_PRINCIPAL) {
            throw new ProtocolError(TOO_MANY_SUBSCRIPTIONS, 'per-principal subscription limit reached');
        }
        const userToken = this._tokens.get(principal);
        if (!userToken) {
            throw new ProtocolError(EVENT_UNAUTHORIZED, `no Discord token registered for principal ${principal}`);
        }

        // Require at least one scoping parameter so a subscribe without filters
        // can't silently match every event regardless of access. Per-event authz
        // (filterDelivery) is still the ultimate gate against the event's actual
        // guild/channel, since the subscriber's filter narrows scope but doesn't
        // prove access.
        if (!params.guildId && !params.channelId) {
            throw new ProtocolError(EVENT_UNAUTHORIZED, 'subscription must specify guildId or channelId');
        }

        if (params.guildId) {
            const guilds = await this._guildsFor(principal, userToken);
            if (!guilds.has(params.guildId)) {
                throw new ProtocolError(EVENT_UNAUTHORIZED, `user not in guild ${params.guildId}`);
            }
        }
        if (params.channelId) {
            const perms = await this._channelPermsFor(principal, params.channelId);
            if (!(perms & PERM_VIEW_CHANNEL) || !(perms & PERM_READ_MESSAGE_HISTORY)) {
                throw new ProtocolError(EVENT_UNAUTHORIZED, `user cannot read channel ${params.channelId}`);
            }
        }
        this._subs.set(subId, { principal, guildId: params.guildId, channelId: params.channelId });
        this._subsByPrincipal.set(principal, (this._subsByPrincipal.get(principal) ?? 0) + 1);
    }

    release(subId: string): void {
        const entry = this._subs.get(subId);
        if (!entry) return;
        this._subs.delete(subId);
        const count = (this._subsByPrincipal.get(entry.principal) ?? 1) - 1;
        if (count <= 0) this._subsByPrincipal.delete(entry.principal);
        else this._subsByPrincipal.set(entry.principal, count);
    }

    /**
     * Per-event authorization decision. Called by the async `matches` hook
     * for each delivery. Uses cached perms when available; on cache miss
     * fetches from Discord (one round-trip the first time an event is seen
     * on a new channel, cached thereafter).
     *
     * A guild-scoped sub can legitimately receive events from channels the
     * user can't read — those just return `false` here and are dropped. No
     * termination; the sub stays alive for channels the user can still see.
     */
    async canAccess(subId: string, eventGuildId: string | null, eventChannelId: string | undefined): Promise<boolean> {
        const entry = this._subs.get(subId);
        if (!entry) return false;
        const userToken = this._tokens.get(entry.principal);
        if (!userToken) return false;
        try {
            if (eventGuildId) {
                const guilds = await this._guildsFor(entry.principal, userToken);
                if (!guilds.has(eventGuildId)) return false;
            }
            if (eventChannelId) {
                const perms = await this._channelPermsFor(entry.principal, eventChannelId);
                if (!(perms & PERM_VIEW_CHANNEL) || !(perms & PERM_READ_MESSAGE_HISTORY)) return false;
            }
            return true;
        } catch {
            // Upstream check failed: deny this event. The next event will
            // retry (no cache is populated on this path).
            return false;
        }
    }

    private async _guildsFor(principal: string, userToken: string): Promise<Set<string>> {
        const key = `guilds:${principal}`;
        const cached = this._guildCache.get(key);
        if (cached) return cached;
        const guilds = await this._api.listUserGuilds(userToken);
        const ids = new Set(guilds.map(g => g.id));
        this._guildCache.set(key, ids);
        return ids;
    }

    private async _channelPermsFor(principal: string, channelId: string): Promise<bigint> {
        const userToken = this._tokens.get(principal);
        if (!userToken) return 0n;
        const key = `chperm:${principal}:${channelId}`;
        const cached = this._permCache.get(key);
        if (cached !== undefined) return cached;
        // We need the Discord user id; derive from token via a simple
        // `/users/@me` call (cached separately would be ideal but we piggyback
        // on the perms cache TTL).
        const auth = userToken.startsWith('Bearer ') ? userToken : `Bearer ${userToken}`;
        const me = (await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: auth } })).json()) as {
            id: string;
        };
        const perms = await this._api.getChannelPermsForUser(channelId, me.id);
        this._permCache.set(key, perms);
        return perms;
    }
}

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
            partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
        });

    const server = new McpServer(
        { name: 'discord-events', version: '1.0.0' },
        {
            events: {
                push: { heartbeatIntervalMs: 10_000 },
                webhook: { ttlMs: 5 * 60 * 1000, urlValidation: { allowInsecure: true, allowPrivateNetworks: true } }
            }
        }
    );

    const authz = new Authz(new UserTokenStore(process.env.DEMO_USER_TOKENS), new DiscordApi(token ?? 'unused-when-injected'));

    // Authz-aware matches closure. Runs once per (event, subscription) pair:
    //   1. base filter — does the sub's params match the event's guild/channel?
    //   2. async authz check — does the subscriber have upstream access to
    //      this event's actual channel? First call per channel hits Discord;
    //      subsequent calls hit the TTL cache synchronously.
    const matchesChannel = async (params: Filter, data: Record<string, unknown>, ctx: { subscriptionId: string }) => {
        if (!filterMatches(params, data)) return false;
        const evGuildId = typeof data.guildId === 'string' ? data.guildId : null;
        const evChannelId = typeof data.channelId === 'string' ? data.channelId : undefined;
        return authz.canAccess(ctx.subscriptionId, evGuildId, evChannelId);
    };

    // --- Gateway → broadcast emit wiring ---
    //
    // No targeted emit: broadcasts enter the SDK's unified event log so that
    // `--from <cursor>` resume works across reconnects. Per-subscriber authz
    // is enforced later by the `matchesChannel` hook above.

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

    const channelHooks = {
        onSubscribe: async (subId: string, params: Filter, ctx: ServerContext) => {
            await authz.authorise(subId, params, ctx);
        },
        onUnsubscribe: async (subId: string) => {
            authz.release(subId);
        }
    };

    server.registerEvent(
        'discord.message_create',
        {
            description: 'A new message was posted in a text channel (gated by subscriber access)',
            inputSchema: filterSchema,
            payloadSchema: messagePayload,
            matches: matchesChannel,
            hooks: channelHooks,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    server.registerEvent(
        'discord.reaction_add',
        {
            description: 'A reaction was added to a message (gated by subscriber access)',
            inputSchema: filterSchema,
            payloadSchema: reactionPayload,
            matches: matchesChannel,
            hooks: channelHooks,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    server.registerEvent(
        'discord.member_join',
        {
            description: 'A user joined a guild (gated by subscriber guild membership)',
            inputSchema: filterSchema.pick({ guildId: true }),
            payloadSchema: memberPayload,
            matches: (params, data) => !params.guildId || params.guildId === data.guildId,
            hooks: channelHooks,
            buffer: { capacity: 500 }
        },
        emitOnlyCheck
    );

    // --- Lifecycle ---
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
