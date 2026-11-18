/**
 * Serves two event types with the Events extension (SEP-3415):
 * `counter.changed`, which the SDK reads through `check` from a counter the
 * `increment` tool bumps, and `timer.tick`, which a timer feeds through
 * `emit()`. Clients take them by poll or push on either transport; on the HTTP
 * leg, where a demo bearer token names the caller, also by webhook.
 *
 * One binary, either transport — selected by `--http --port <N>` (defaults to
 * stdio). See `examples/CONTRIBUTING.md` for the canonical shape.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';
import { EventsExtension } from '@modelcontextprotocol/server/ext/events';
import { nodeWebhookSender } from '@modelcontextprotocol/server/ext/events/node';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

// Where the client's webhook receiver listens (see client.ts).
const RECEIVER_PORT = process.env.EVENTS_RECEIVER_PORT ?? '8599';

const { transport, port } = parseExampleArgs();

// One extension serves every server instance below.
const events = new EventsExtension({
    // The caller the bearer token names; stdio has none.
    getPrincipal: ctx => {
        const sub = ctx.http?.authInfo?.extra?.sub;
        return typeof sub === 'string' ? sub : null;
    },
    // Webhook delivery needs a principal, so only the HTTP leg offers it; the receiver's plain-http loopback origin is trusted for development only.
    ...(transport === 'http' && {
        webhookTtlMs: 60_000,
        webhookSender: nodeWebhookSender(),
        trustedOrigins: [`http://127.0.0.1:${RECEIVER_PORT}`]
    }),
    // Short intervals keep the story fast: push and webhook check every 250 ms, poll clients come back after 1 s.
    checkIntervalMs: 250,
    defaultNextPollMs: 1000
});

// The upstream of the check type: a cursor is a count, and each step up from it is one event.
let count = 0;

events.registerEvent('counter.changed', {
    description: 'The counter went up',
    payloadSchema: z.object({ value: z.number().int() }),
    check: (ctx, _args, cursor) => {
        if (cursor === null) return { events: [], cursor: String(count) };
        const from = Number(cursor);
        // A cursor this counter never issued (it starts at 0 after a restart): start again from now and report the gap.
        if (!Number.isInteger(from) || from < 0 || from > count) return { events: [], cursor: String(count), truncated: true };
        const to = Math.min(count, from + (ctx.maxEvents ?? count));
        const values = Array.from({ length: to - from }, (_, index) => from + index + 1);
        return { events: values.map(value => ({ eventId: `value-${value}`, data: { value } })), cursor: String(to), hasMore: to < count };
    }
});

// The upstream of the emit-only type: a timer that emits a tick to every subscription.
const tick = events.registerEvent('timer.tick', {
    emitOnly: true,
    description: 'The server timer ticked',
    payloadSchema: z.object({ tick: z.number().int() })
});
let ticks = 0;
setInterval(() => void tick.emit({ data: { tick: ++ticks } }), 200).unref();

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'events-example', version: '1.0.0' });
    mcp.registerTool('increment', { description: 'Add one to the counter', inputSchema: z.object({}) }, () => {
        count += 1;
        return { content: [{ type: 'text', text: String(count) }] };
    });
    events.attach(mcp);
    return mcp;
}

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    // DEMO ONLY: one static token, whose subject becomes the principal; verify real tokens here.
    const verifier: OAuthTokenVerifier = {
        async verifyAccessToken(token): Promise<AuthInfo> {
            if (token !== 'demo-token') throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
            return {
                token,
                clientId: 'events-example-client',
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                extra: { sub: 'demo-user' }
            };
        }
    };
    const gate = requireBearerAuth({ verifier });
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` arms localhost host/origin validation by default; bind loopback explicitly to match.
    const app = createMcpHonoApp();
    app.all('/mcp', async c => {
        const authInfo = await gate(c.req.raw);
        return authInfo instanceof Response ? authInfo : handler.fetch(c.req.raw, { authInfo });
    });
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
