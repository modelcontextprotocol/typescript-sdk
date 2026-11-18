/**
 * Events (SEP-3415) served by the conformance server, and the thirteen
 * `events_conformance_*` control tools the conformance#521 server suites
 * drive. Three event types: a counter (a check type offering every mode), an
 * emit-only alert feed, and a pulse with no replay (`cursor: null`).
 */
import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo, CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer as Server } from '@modelcontextprotocol/server';
import type { CheckContext, EventHandle, EventResult, WebhookSender } from '@modelcontextprotocol/server/ext/events';
import { EventsError, EventsExtension, InMemoryWebhookSubscriptionStore } from '@modelcontextprotocol/server/ext/events';
import { nodeWebhookSender } from '@modelcontextprotocol/server/ext/events/node';
import * as z from 'zod/v4';

const COUNTER = 'conformance.counter';
const ALERTS = 'conformance.alerts';
const PULSE = 'conformance.pulse';

// The principal of every request, unless subscribe_as authenticates its own subscribe as another.
const PRINCIPAL = 'mcp-conformance';
const PRINCIPAL_EXTRA = 'principal';
const MAX_SUBSCRIPTIONS = 16;
const COUNTER_TICK_MS = 2000;
const COUNTER_RETENTION = 1000;
const ALERT_EVERY_MS = 3000;
const PULSE_EVERY_MS = 5000;

// The callback origin conformance#521's events-webhook subscribes with; it exists only to be a distinct key.
const PLACEHOLDER_ORIGIN = 'https://conformance.invalid';

// Outside the extension's process state, so a simulated restart leaves webhook subscriptions in place.
const store = new InMemoryWebhookSubscriptionStore();

const nodeSender = nodeWebhookSender();

// Emulates the SEP's server-configured allowlist (verification path 2) for the suite's placeholder origin, as #521's allow_callback_origin JSDoc describes; the SDK itself only does the handshake.
const webhookSender: WebhookSender = async request => {
    if (new URL(request.url).origin === PLACEHOLDER_ORIGIN) {
        const body = JSON.parse(request.body) as { type?: unknown; challenge?: unknown };
        if (body.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    }
    return nodeSender(request);
};

export const conformanceEvents = new EventsExtension({
    webhookTtlMs: 3_600_000,
    webhookSender,
    webhookStore: store,
    getPrincipal: ctx => (ctx.http?.authInfo?.extra?.[PRINCIPAL_EXTRA] as string | undefined) ?? PRINCIPAL,
    // Under the counter's tick, so heartbeats show between events.
    heartbeatMs: 1000,
    // So a control's error or gap reaches a stream or webhook well within the suites' five-second waits.
    checkIntervalMs: 1000,
    maxSubscriptions: MAX_SUBSCRIPTIONS
});

// The internal controls the fixture needs from the extension (Symbol.for('mcp.events.testHook')).
interface EventsTestHook {
    generation(): number;
    restart(): void;
    addTrustedOrigin(origin: string): void;
}

const testHook = (conformanceEvents as unknown as Record<symbol, EventsTestHook>)[Symbol.for('mcp.events.testHook')]!;

// The counter's upstream: one tick every COUNTER_TICK_MS, the last COUNTER_RETENTION of them kept.
const ticks: { n: number; eventId: string; timestamp: string }[] = [];
let head = 0;
setInterval(() => {
    head += 1;
    ticks.push({ n: head, eventId: `tick-${head}`, timestamp: new Date().toISOString() });
    if (ticks.length > COUNTER_RETENTION) ticks.shift();
}, COUNTER_TICK_MS).unref();

// Upstream conditions the controls ask for, keyed by event type or webhook subscription id, each taken by the next read.
const failNext = new Set<string>();
const gapNext = new Set<string>();

function take(set: Set<string>, ctx: CheckContext): boolean {
    return set.delete(ctx.name) || set.delete(ctx.subscriptionId);
}

function readCounter(ctx: CheckContext, cursor: string | null): EventResult<{ n: number }> {
    if (cursor === null) return { events: [], cursor: String(head) };
    if (take(failNext, ctx)) throw new Error('counter upstream unavailable (events_conformance_yield_error)');
    const from = /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN;
    const oldest = ticks[0]?.n ?? head + 1;
    // A gap, a cursor this counter never issued, or one older than its retention: resume from now.
    if (take(gapNext, ctx) || !(from <= head) || from < oldest - 1) return { events: [], cursor: String(head), truncated: true };
    const since = ticks.filter(tick => tick.n > from);
    const batch = since.slice(0, ctx.maxEvents ?? since.length);
    return {
        events: batch.map(({ n, eventId, timestamp }) => ({ eventId, timestamp, data: { n } })),
        cursor: String(batch.at(-1)?.n ?? from),
        hasMore: batch.length < since.length
    };
}

const counter = conformanceEvents.registerEvent(COUNTER, {
    description: 'A counter that ticks every two seconds; replays from a cursor.',
    inputSchema: z.object({ label: z.string().optional() }),
    payloadSchema: z.object({ n: z.number().int() }),
    check: (ctx, _args, cursor) => readCounter(ctx, cursor)
});

const alerts = conformanceEvents.registerEvent(ALERTS, {
    emitOnly: true,
    description: 'Alerts emitted every three seconds, filtered by minimum severity; poll only.',
    inputSchema: z.object({ minSeverity: z.number().int().min(0).max(3).optional() }),
    payloadSchema: z.object({ severity: z.number().int(), message: z.string() }),
    match: (_ctx, event, args) => event.data.severity >= (args.minSeverity ?? 0),
    transform: (_ctx, event, args) => ({
        ...event,
        data: { ...event.data, message: `[min ${args.minSeverity ?? 0}] ${event.data.message}` }
    }),
    delivery: { push: false, webhook: false }
});
let alertCount = 0;
setInterval(() => {
    alertCount += 1;
    alerts.emit({ data: { severity: alertCount % 4, message: `alert ${alertCount}` } }).catch(() => {});
}, ALERT_EVERY_MS).unref();

// The pulse has no history: each subscription gets the beats since its own previous read, and never a cursor.
let beat = 0;
setInterval(() => (beat += 1), PULSE_EVERY_MS).unref();
const beatSeen = new Map<string, number>();

const pulse = conformanceEvents.registerEvent(PULSE, {
    description: 'A live pulse every five seconds with no replay; every cursor is null. Push and webhook only.',
    inputSchema: z.object({}),
    payloadSchema: z.object({ beat: z.number().int() }),
    check: ctx => {
        const seen = beatSeen.get(ctx.subscriptionId);
        beatSeen.set(ctx.subscriptionId, beat);
        const events = seen === undefined || seen === beat ? [] : [{ data: { beat } }];
        // A gap yield_gap asked for comes out as `truncated` with `cursor: null`, which the SDK must not pass on (SEP l.713).
        return take(gapNext, ctx) ? { events, cursor: null, truncated: true } : { events, cursor: null };
    },
    onUnsubscribe: ctx => void beatSeen.delete(ctx.subscriptionId),
    // Poll would work; the suite's sep-3415-poll-mode-unsupported needs one type without it, and this is that type.
    delivery: { poll: false }
});

// The handle of every event type served, by name, so controls can update, remove or terminate it.
const handles = new Map<string, EventHandle>([
    [COUNTER, counter],
    [ALERTS, alerts],
    [PULSE, pulse]
]);

// Event types the catalog control added, and the payload revision of each.
const minted = new Map<string, number>();
let mintedCount = 0;

function mint(name: string, revision: number): EventHandle {
    return conformanceEvents.registerEvent(name, {
        emitOnly: true,
        description: `Added by events_conformance_catalog (payload revision ${revision}).`,
        inputSchema: z.object({}),
        payloadSchema: z.object({ revision: z.literal(revision) })
    });
}

// A subscribe sent on another principal's behalf, through a server serving the same extension and store.
const subscribeAsHandler = createMcpHandler(() => {
    const server = new Server({ name: 'events-conformance-subscribe-as', version: '1.0.0' });
    conformanceEvents.attach(server);
    return server;
});

async function subscribeAs(principal: string, name: string, url: string): Promise<string> {
    const authInfo: AuthInfo = {
        token: 'events-conformance',
        clientId: 'events-conformance',
        scopes: [],
        extra: { [PRINCIPAL_EXTRA]: principal }
    };
    const client = new Client(
        { name: 'events-conformance-subscribe-as', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            fetch: (input, init) => subscribeAsHandler.fetch(new Request(input, init), { authInfo })
        })
    );
    try {
        const secret = `whsec_${randomBytes(32).toString('base64')}`;
        const result = await client.request(
            { method: 'events/subscribe', params: { name, arguments: {}, delivery: { mode: 'webhook', url, secret } } },
            z.looseObject({ id: z.string() })
        );
        return result.id;
    } finally {
        await client.close();
    }
}

async function liveRecord(id: string) {
    const record = await store.get(id);
    return record !== undefined && record.expiresAt > Date.now() ? record : undefined;
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const refuse = (reason: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: reason }] });

function forbidden(control: string): EventsError {
    return new EventsError('forbidden', `Ended by ${control}`);
}

/** Registers the `events_conformance_*` control tools on `mcp`, each as conformance#521 `helpers.ts` defines it. */
export function registerEventsControls(mcp: McpServer): void {
    const named = z.object({ name: z.string() });
    const byId = z.object({ id: z.string() });
    const tenant = z.object({ principal: z.string(), name: z.string(), url: z.string() });
    const none = z.object({});

    mcp.registerTool(
        'events_conformance_allow_callback_origin',
        { description: 'Trusts one webhook callback origin for the rest of the process.', inputSchema: z.object({ origin: z.string() }) },
        ({ origin }) => {
            try {
                testHook.addTrustedOrigin(origin);
            } catch (error) {
                return refuse(String(error));
            }
            return text('ok');
        }
    );

    mcp.registerTool(
        'events_conformance_catalog',
        {
            description: 'Adds an event type (answers "ok: <name>"), or removes, retypes or extends one it added.',
            inputSchema: z.object({ op: z.enum(['add', 'remove', 'retype', 'extend']), name: z.string().optional() })
        },
        ({ op, name }) => {
            if (op === 'add') {
                const added = `conformance.minted.${++mintedCount}`;
                minted.set(added, 1);
                handles.set(added, mint(added, 1));
                return text(`ok: ${added}`);
            }
            const revision = name === undefined ? undefined : minted.get(name);
            const handle = name === undefined ? undefined : handles.get(name);
            if (name === undefined || revision === undefined || handle === undefined) {
                return refuse(`${op} needs the name of a type this control added`);
            }
            if (op === 'remove') {
                handle.remove();
                minted.delete(name);
                handles.delete(name);
            } else if (op === 'retype') {
                minted.set(name, revision + 1);
                handles.set(name, mint(name, revision + 1));
            } else {
                handle.update({ inputSchema: z.object({ note: z.string().optional() }) });
            }
            return text('ok');
        }
    );

    mcp.registerTool('events_conformance_generation', { description: 'Answers the current restart generation.', inputSchema: none }, () =>
        text(String(testHook.generation()))
    );

    mcp.registerTool(
        'events_conformance_quota',
        { description: 'Answers the subscription cap and an event type it applies to, as {"name", "max"}.', inputSchema: none },
        () => text(JSON.stringify({ name: COUNTER, max: MAX_SUBSCRIPTIONS }))
    );

    mcp.registerTool(
        'events_conformance_restart',
        {
            description: "Drops the extension's process state as a restart would, keeping the store; answers the new generation.",
            inputSchema: none
        },
        () => {
            testHook.restart();
            return text(String(testHook.generation()));
        }
    );

    mcp.registerTool(
        'events_conformance_subscribe_as',
        { description: "Subscribes a webhook on another principal's behalf; answers the subscription id.", inputSchema: tenant },
        async ({ principal, name, url }) => {
            try {
                return text(await subscribeAs(principal, name, url));
            } catch (error) {
                return refuse(String(error));
            }
        }
    );

    mcp.registerTool(
        'events_conformance_subscription_exists',
        {
            description: 'Answers "true" while a principal\'s webhook subscription to a callback is registered, else "false".',
            inputSchema: tenant
        },
        async ({ principal, name, url }) => {
            for await (const record of store.listByName(name)) {
                if (record.principal === principal && record.url === url && record.expiresAt > Date.now()) return text('true');
            }
            return text('false');
        }
    );

    mcp.registerTool(
        'events_conformance_subscription_state',
        { description: 'Answers "active" or "absent" for a webhook subscription id.', inputSchema: byId },
        async ({ id }) => text((await liveRecord(id)) === undefined ? 'absent' : 'active')
    );

    mcp.registerTool(
        'events_conformance_terminate',
        { description: 'Ends every live subscription to an event type with a forbidden error.', inputSchema: named },
        async ({ name }) => {
            const handle = handles.get(name);
            if (handle === undefined) return refuse(`no event type ${name}`);
            await handle.terminate(forbidden('events_conformance_terminate'));
            return text('ok');
        }
    );

    mcp.registerTool(
        'events_conformance_webhook_gap',
        { description: 'Makes the next read of one counter webhook subscription report a gap, sent as a gap envelope.', inputSchema: byId },
        async ({ id }) => {
            const record = await liveRecord(id);
            if (record?.name !== COUNTER) return refuse(`no ${COUNTER} webhook subscription ${id}`);
            gapNext.add(id);
            return text('ok');
        }
    );

    mcp.registerTool(
        'events_conformance_webhook_terminate',
        { description: 'Ends one webhook subscription with a forbidden error, sent as a terminated envelope.', inputSchema: byId },
        async ({ id }) => {
            const record = await liveRecord(id);
            const handle = record === undefined ? undefined : handles.get(record.name);
            if (handle === undefined) return refuse(`no webhook subscription ${id}`);
            await handle.terminate(forbidden('events_conformance_webhook_terminate'), { subscriptionId: id });
            return text('ok');
        }
    );

    mcp.registerTool(
        'events_conformance_yield_error',
        { description: "Makes the counter's next read fail with a transient upstream error.", inputSchema: named },
        ({ name }) => {
            if (name !== COUNTER) return refuse(`only ${COUNTER} has an upstream that can fail`);
            failNext.add(name);
            return text('ok');
        }
    );

    mcp.registerTool(
        'events_conformance_yield_gap',
        {
            description: 'Makes the next read of the counter (fresh cursor) or the pulse (cursor null) report a gap as truncated.',
            inputSchema: named
        },
        ({ name }) => {
            if (name !== COUNTER && name !== PULSE) return refuse(`only ${COUNTER} and ${PULSE} read an upstream`);
            gapNext.add(name);
            return text('ok');
        }
    );
}
