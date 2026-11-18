import { createHash } from 'node:crypto';

import { generateWebhookSecret, parseWebhookSecret, verifyWebhookSignature } from '@modelcontextprotocol/core-internal/ext/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type {
    CheckContext,
    EventContext,
    EventResult,
    EventsOptions,
    ListEventsResult,
    PollEventsResult,
    SubscribeEventsResult,
    WebhookSendOutcome,
    WebhookSendRequest,
    WebhookSubscriptionRecord
} from '../../../src/ext/events/index';
import { EventsError, EventsExtension, InMemoryWebhookSubscriptionStore } from '../../../src/ext/events/index';
import type { EventsTestHook } from '../../../src/ext/events/testHook';
import { errorOf, resultOf, serve } from './harness';

const P = z.object({ n: z.number() });
const HOOK = 'https://hooks.example.com/mcp';
const OTHER_HOOK = 'https://other.example.com/hook';
const SECRET = generateWebhookSecret();
const SUB_ID = /^sub_[\w-]{22}$/;
const UNSUPPORTED = { code: -32_026, data: { feature: 'deliveryMode', value: 'webhook' } };

type Respond = (request: WebhookSendRequest) => WebhookSendOutcome | Promise<WebhookSendOutcome>;
type Check = (ctx: CheckContext, args: Record<string, unknown>, cursor: string | null) => EventResult<{ n: number }>;

interface SubscribeInput {
    name?: string;
    arguments?: Record<string, unknown>;
    url?: string;
    secret?: string;
    cursor?: string | null;
    ttlMs?: number | null;
    maxAgeMs?: number;
}

const getPrincipal: EventsOptions['getPrincipal'] = ctx => (ctx.http?.authInfo?.extra?.sub as string | undefined) ?? null;

function testHook(events: EventsExtension): EventsTestHook {
    return (events as unknown as Record<symbol, EventsTestHook>)[Symbol.for('mcp.events.testHook')]!;
}

function bodyOf(request: WebhookSendRequest): Record<string, unknown> {
    return JSON.parse(request.body) as Record<string, unknown>;
}

function isVerification(request: WebhookSendRequest): boolean {
    return bodyOf(request).type === 'verification';
}

// Echoes a verification challenge, and answers anything else with `answer()`.
function echo(answer: () => WebhookSendOutcome = () => ({ status: 200, body: '' })): Respond {
    return request => {
        const body = bodyOf(request);
        return body.type === 'verification' ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : answer();
    };
}

// A sender that records each request and answers with `respond`; signing runs off the fake clock, so tests wait with `until`.
function receiver(respond: Respond) {
    const requests: WebhookSendRequest[] = [];
    const waiters: Array<{ count: number; resolve(): void }> = [];
    const sender = (request: WebhookSendRequest): Promise<WebhookSendOutcome> => {
        requests.push(request);
        for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve();
        return Promise.resolve(respond(request));
    };
    const until = (count: number): Promise<void> =>
        new Promise(resolve => {
            if (requests.length >= count) resolve();
            else waiters.push({ count, resolve });
        });
    return { sender, requests, until, deliveries: () => requests.filter(request => !isVerification(request)) };
}

const extensions: EventsExtension[] = [];

// One server process in webhook mode, with its own recording sender.
function replica(options: Partial<EventsOptions> & { respond?: Respond } = {}) {
    const { respond = echo(), ...rest } = options;
    const post = receiver(respond);
    const events = new EventsExtension({ webhookTtlMs: 1_800_000, webhookSender: post.sender, getPrincipal, ...rest });
    extensions.push(events);
    return { events, post, hook: testHook(events) };
}

// Requests as one principal; `null` sends no auth info.
function client(events: EventsExtension, principal: string | null = 'u1') {
    const authInfo = { token: 'tok', clientId: 'app', scopes: [], extra: { sub: principal } };
    const { rpc } = serve(events, principal === null ? {} : { authInfo });
    return {
        rpc,
        subscribe: ({ name = 'e', url = HOOK, secret = SECRET, ...rest }: SubscribeInput = {}) =>
            rpc('events/subscribe', { name, delivery: { mode: 'webhook', url, secret }, ...rest }),
        unsubscribe: ({ name = 'e', url = HOOK, ...rest }: { name?: string; arguments?: Record<string, unknown>; url?: string } = {}) =>
            rpc('events/unsubscribe', { name, delivery: { url }, ...rest })
    };
}

function subscribed(reply: Parameters<typeof resultOf>[0]): SubscribeEventsResult {
    return resultOf(reply) as SubscribeEventsResult;
}

async function stored(store: InMemoryWebhookSubscriptionStore, name = 'e'): Promise<WebhookSubscriptionRecord[]> {
    const records: WebhookSubscriptionRecord[] = [];
    for await (const record of store.listByName(name)) records.push(record);
    return records;
}

function verifies(request: WebhookSendRequest, secret: string): Promise<boolean> {
    const { headers } = request;
    return verifyWebhookSignature(
        [parseWebhookSecret(secret)!],
        headers['webhook-id']!,
        Number(headers['webhook-timestamp']),
        request.body,
        headers['webhook-signature']!
    );
}

// Lets queued work act on answers already received, without moving the clock.
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

const REVOKED = { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } };

function revoked(): EventsError {
    return new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' });
}

// A store whose next `get` or `put` waits for the test, which can act while a subscribe is between its read and its write.
class GatedStore extends InMemoryWebhookSubscriptionStore {
    #held: { method: 'get' | 'put'; reached(): void; released: Promise<void> } | undefined;

    hold(method: 'get' | 'put'): { reached: Promise<void>; release(): void } {
        let reached!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>(resolve => (reached = resolve));
        this.#held = { method, reached, released: new Promise<void>(resolve => (release = resolve)) };
        return { reached: arrived, release };
    }

    override async get(id: string): Promise<WebhookSubscriptionRecord | undefined> {
        await this.#wait('get');
        return super.get(id);
    }

    override async put(record: WebhookSubscriptionRecord): Promise<void> {
        await this.#wait('put');
        return super.put(record);
    }

    async #wait(method: 'get' | 'put'): Promise<void> {
        const held = this.#held;
        if (held?.method !== method) return;
        this.#held = undefined;
        held.reached();
        await held.released;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    for (const events of extensions.splice(0)) testHook(events).restart();
    vi.useRealTimers();
});

describe('events/subscribe: validation', () => {
    it('needs webhook mode and a principal, checked before the event type (F12)', async () => {
        const plain = new EventsExtension({ getPrincipal });
        plain.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const off = client(plain);
        const list = resultOf(await off.rpc('events/list')) as ListEventsResult;
        expect(list.events[0]!.delivery).toEqual(['poll', 'push']);
        expect(errorOf(await off.subscribe())).toMatchObject(UNSUPPORTED);
        expect(errorOf(await off.subscribe({ name: 'missing' }))).toMatchObject(UNSUPPORTED);
        expect(errorOf(await off.unsubscribe())).toMatchObject(UNSUPPORTED);
        const legacy = { name: 'e', delivery: { mode: 'webhook', url: HOOK, secret: SECRET } };
        expect(errorOf(await off.rpc('events/subscribe', legacy, { era: 'legacy' }))).toMatchObject({ code: -32_601 });

        const { events, post } = replica();
        events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        events.registerEvent('no-hook', { emitOnly: true, payloadSchema: P, delivery: { webhook: false } });
        const anonymous = client(events, null);
        expect(errorOf(await anonymous.subscribe())).toMatchObject({ code: -32_024 });
        expect(errorOf(await anonymous.subscribe({ name: 'missing' }))).toMatchObject({ code: -32_024 });
        expect(errorOf(await anonymous.unsubscribe())).toMatchObject({ code: -32_024 });
        const alice = client(events);
        expect(errorOf(await alice.subscribe({ name: 'missing' }))).toMatchObject({ code: -32_023, data: { kind: 'event' } });
        expect(errorOf(await alice.subscribe({ name: 'no-hook', url: 'http://example.com/hook' }))).toMatchObject(UNSUPPORTED);
        expect(errorOf(await alice.rpc('events/subscribe', legacy, { era: 'legacy' }))).toMatchObject({ code: -32_601 });
        expect(post.requests).toHaveLength(0);
    });

    it('requires https unless the exact origin is trusted', async () => {
        const { events, post } = replica({ trustedOrigins: ['http://127.0.0.1:9000'] });
        events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        for (const url of [
            'http://example.com/hook',
            'hooks.example.com/mcp',
            'http://127.0.0.1:9001/hook',
            'http://localhost:9000/hook'
        ]) {
            expect(errorOf(await alice.subscribe({ url }))).toMatchObject({ code: -32_602 });
        }
        expect(post.requests).toHaveLength(0);
        subscribed(await alice.subscribe({ url: 'http://127.0.0.1:9000/hook' }));
        subscribed(await alice.subscribe({ url: HOOK }));
        expect(post.requests.map(request => [request.url, request.trusted])).toEqual([
            ['http://127.0.0.1:9000/hook', true],
            [HOOK, false]
        ]);
    });

    it('validates the secret', async () => {
        const { events, post } = replica();
        events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        const secrets = ['whsec_short', `whsec_${btoa('x'.repeat(23))}`, `whsec_${btoa('x'.repeat(65))}`, btoa('x'.repeat(32))];
        for (const secret of secrets) expect(errorOf(await alice.subscribe({ secret }))).toMatchObject({ code: -32_602 });
        expect(post.requests).toHaveLength(0);
    });

    it('derives one stable id per (principal, url, name, arguments) (Review Focus 4)', async () => {
        const onSubscribe = vi.fn();
        const { events, post } = replica();
        events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe });
        events.registerEvent('f', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        const first = subscribed(await alice.subscribe({ arguments: { a: 1, b: { c: 2 } } }));
        const reordered = subscribed(await alice.subscribe({ arguments: { b: { c: 2 }, a: 1 } }));
        const digest = createHash('sha256')
            .update(JSON.stringify(['u1', HOOK, 'e', { a: 1, b: { c: 2 } }]))
            .digest('base64url');
        expect(first.id).toBe(`sub_${digest.slice(0, 22)}`);
        expect(first.id).toMatch(SUB_ID);
        expect(reordered.id).toBe(first.id);
        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(onSubscribe.mock.calls[0]![0]).toMatchObject({ name: 'e', subscriptionId: first.id, principal: 'u1', mode: 'webhook' });
        expect(post.requests[0]!.headers['X-MCP-Subscription-Id']).toBe(first.id);

        const others = [
            subscribed(await client(events, 'u2').subscribe({ arguments: { a: 1, b: { c: 2 } } })).id,
            subscribed(await alice.subscribe({ arguments: { a: 1, b: { c: 2 } }, url: OTHER_HOOK })).id,
            subscribed(await alice.subscribe({ name: 'f', arguments: { a: 1, b: { c: 2 } } })).id,
            subscribed(await alice.subscribe({ arguments: { a: 1, b: { c: 3 } } })).id
        ];
        expect(new Set([first.id, ...others]).size).toBe(5);
    });

    it.each([
        [3_600_000, 1_800_000],
        [1000, 60_000],
        [null, 1_800_000],
        [undefined, 1_800_000]
    ])('grants ttlMs %s as %i', async (ttlMs, ms) => {
        const store = new InMemoryWebhookSubscriptionStore();
        const { events } = replica({ webhookStore: store });
        events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const reply = subscribed(await client(events).subscribe({ ttlMs }));
        expect(reply.refreshBefore).toBe(new Date(Date.now() + ms).toISOString());
        expect((await store.get(reply.id))?.expiresAt).toBe(Date.now() + ms);
    });
});

describe('events/subscribe: creating', () => {
    it('checks the quota before verification and onSubscribe', async () => {
        const onSubscribe = vi.fn();
        const { events, post } = replica({ maxSubscriptions: 1 });
        events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe });
        const alice = client(events);
        subscribed(await alice.subscribe({ arguments: { a: 1 } }));
        expect(errorOf(await alice.subscribe({ arguments: { a: 2 }, url: OTHER_HOOK }))).toMatchObject({
            code: -32_025,
            data: { limit: 'subscriptions', max: 1 }
        });
        expect(post.requests).toHaveLength(1);
        expect(onSubscribe).toHaveBeenCalledOnce();

        // A refresh is never refused, and the webhook subscription counts against poll too.
        subscribed(await alice.subscribe({ arguments: { a: 1 } }));
        expect(errorOf(await alice.rpc('events/poll', { name: 'e' }))).toMatchObject({ code: -32_025 });
    });

    it('stores nothing when verification fails', async () => {
        const onSubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post, hook } = replica({ webhookStore: store, respond: () => ({ status: 200, body: '{"challenge":"wrong"}' }) });
        events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe });
        expect(errorOf(await client(events).subscribe())).toMatchObject({ code: -32_027, data: { reason: 'challenge_failed' } });
        expect(post.requests).toHaveLength(1);
        expect(onSubscribe).not.toHaveBeenCalled();
        expect(await stored(store)).toEqual([]);
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });
    });

    it('forgets a create that onSubscribe refuses after verification', async () => {
        let refuse = true;
        const onUnsubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post, hook } = replica({ webhookStore: store });
        events.registerEvent('e', {
            emitOnly: true,
            payloadSchema: P,
            onSubscribe: () => {
                if (refuse) throw new EventsError('forbidden', 'Forbidden', { reason: 'denied' });
            },
            onUnsubscribe
        });
        expect(errorOf(await client(events).subscribe())).toEqual({ code: -32_024, message: 'Forbidden', data: { reason: 'denied' } });
        expect(await stored(store)).toEqual([]);
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });
        expect(onUnsubscribe).not.toHaveBeenCalled();

        // The verification it added went with it, so the next create verifies again.
        refuse = false;
        subscribed(await client(events).subscribe());
        expect(post.requests.filter(request => isVerification(request))).toHaveLength(2);
    });

    it('starts an emit-only subscription at the buffer head and flags skipped events as truncated', async () => {
        const { events } = replica();
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        const fresh = subscribed(await alice.subscribe({ arguments: { k: 1 } }));
        expect(fresh).toMatchObject({ cursor: expect.any(String), truncated: false });
        await handle.emit({ data: { n: 1 } });

        const behind = subscribed(await alice.subscribe({ arguments: { k: 2 }, cursor: fresh.cursor }));
        expect(behind.truncated).toBe(true);
        expect(behind.cursor).not.toBe(fresh.cursor);
        const current = subscribed(await alice.subscribe({ arguments: { k: 3 }, cursor: behind.cursor }));
        expect(current).toMatchObject({ cursor: behind.cursor, truncated: false });
        expect(subscribed(await alice.subscribe({ arguments: { k: 4 }, cursor: 'e00000000.0' })).truncated).toBe(true);
    });
});

describe('events/subscribe: refreshing', () => {
    it('refreshes idempotently and rotates the secret', async () => {
        const onSubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe });
        const alice = client(events);
        const first = subscribed(await alice.subscribe({ ttlMs: 600_000 }));
        await vi.advanceTimersByTimeAsync(60_000);
        const next = generateWebhookSecret();
        const refreshed = subscribed(await alice.subscribe({ ttlMs: 600_000, secret: next }));
        expect(refreshed.id).toBe(first.id);
        expect(refreshed.refreshBefore).toBe(new Date(Date.now() + 600_000).toISOString());
        expect(refreshed.refreshBefore).not.toBe(first.refreshBefore);
        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(post.requests).toHaveLength(1);
        expect(await store.get(first.id)).toMatchObject({
            secret: next,
            previousSecret: { secret: SECRET, expiresAt: Date.now() + 300_000 }
        });

        await handle.emit({ data: { n: 1 } });
        await post.until(2);
        const rotated = post.requests[1]!;
        expect(rotated.headers['webhook-signature']!.split(' ')).toHaveLength(2);
        expect(await verifies(rotated, next)).toBe(true);
        expect(await verifies(rotated, SECRET)).toBe(true);

        await vi.advanceTimersByTimeAsync(300_000);
        await handle.emit({ data: { n: 2 } });
        await post.until(3);
        const settled = post.requests[2]!;
        expect(settled.headers['webhook-signature']!.split(' ')).toHaveLength(1);
        expect(await verifies(settled, next)).toBe(true);
        expect(await verifies(settled, SECRET)).toBe(false);
    });

    it('reports deliveryStatus and the watermark on refresh', async () => {
        let answer: WebhookSendOutcome = { status: 500, body: '' };
        const store = new InMemoryWebhookSubscriptionStore();
        const a = replica({ webhookStore: store, respond: echo(() => answer) });
        const b = replica({ webhookStore: store });
        const handle = a.events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        b.events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(a.events);
        const first = subscribed(await alice.subscribe());
        expect(first).not.toHaveProperty('deliveryStatus');
        await handle.emit({ data: { n: 1 } });
        await a.post.until(2);
        await settle();

        const failing = subscribed(await alice.subscribe({ cursor: first.cursor }));
        expect(failing).toMatchObject({ id: first.id, cursor: first.cursor, truncated: false });
        expect(failing.deliveryStatus).toEqual({
            active: true,
            lastDeliveryAt: null,
            lastError: 'http_5xx',
            failedSince: new Date().toISOString()
        });

        answer = { status: 200, body: '' };
        await vi.advanceTimersByTimeAsync(5000);
        await a.post.until(3);
        await settle();
        const healthy = subscribed(await alice.subscribe({ cursor: first.cursor }));
        const { cursor: head } = resultOf(await alice.rpc('events/poll', { name: 'e', cursor: null })) as PollEventsResult;
        expect(healthy.cursor).toBe(head);
        expect(healthy.cursor).not.toBe(first.cursor);
        expect(healthy.deliveryStatus).toEqual({ active: true, lastDeliveryAt: new Date().toISOString(), lastError: null });

        // A replica that holds no delivery state for it answers with the client's cursor and no deliveryStatus (Decision 7).
        const elsewhere = subscribed(await client(b.events).subscribe({ cursor: 'client-cursor' }));
        expect(elsewhere).toMatchObject({ id: first.id, cursor: 'client-cursor', truncated: false });
        expect(elsewhere).not.toHaveProperty('deliveryStatus');
    });

    it('reports a suspension on the refresh that ends it', async () => {
        const { events, post } = replica({ respond: echo(() => ({ status: 503, body: '' })) });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        subscribed(await alice.subscribe());
        for (let n = 1; n <= 100; n++) await handle.emit({ data: { n } });
        await post.until(101);
        await settle();
        expect(subscribed(await alice.subscribe()).deliveryStatus).toMatchObject({ active: false, lastError: 'http_5xx' });
        expect(subscribed(await alice.subscribe()).deliveryStatus).toMatchObject({ active: true, lastError: 'http_5xx' });
    });
});

describe('events/unsubscribe', () => {
    it('unsubscribes by key and reports unknown keys', async () => {
        const onUnsubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, hook } = replica({ webhookStore: store });
        events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const alice = client(events);
        const { id } = subscribed(await alice.subscribe({ arguments: { a: 1 } }));
        const unknown = { code: -32_023, data: { kind: 'subscription' } };
        expect(errorOf(await client(events, 'u2').unsubscribe({ arguments: { a: 1 } }))).toMatchObject(unknown);
        expect(errorOf(await alice.unsubscribe({ arguments: { a: 2 } }))).toMatchObject(unknown);
        expect(errorOf(await alice.unsubscribe({ arguments: { a: 1 }, url: OTHER_HOOK }))).toMatchObject(unknown);
        expect(onUnsubscribe).not.toHaveBeenCalled();

        const { _meta, ...done } = resultOf(await alice.unsubscribe({ arguments: { a: 1 } }));
        expect(done).toEqual({ resultType: 'complete' });
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        const [ctx, args] = onUnsubscribe.mock.calls[0]! as [EventContext, unknown];
        expect(ctx).toMatchObject({ name: 'e', subscriptionId: id, principal: 'u1', mode: 'webhook' });
        expect(ctx.signal.aborted).toBe(true);
        expect(args).toEqual({ a: 1 });
        expect(await store.get(id)).toBeUndefined();
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });

        expect(errorOf(await alice.unsubscribe({ arguments: { a: 1 } }))).toMatchObject(unknown);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
    });
});

describe('several replicas sharing one store', () => {
    it('expires without refresh and follows a refresh made on another replica', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const a = replica({ webhookStore: store });
        const b = replica({ webhookStore: store });
        const onA = vi.fn();
        const onB = vi.fn();
        a.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe: onA });
        b.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe: onB });

        const lapsing = subscribed(await client(a.events).subscribe({ arguments: { k: 1 }, ttlMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(59_999);
        expect(await store.get(lapsing.id)).toBeDefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(await store.get(lapsing.id)).toBeUndefined();
        expect(onA).toHaveBeenCalledOnce();
        expect(onA.mock.calls[0]![0]).toMatchObject({ subscriptionId: lapsing.id, mode: 'webhook' });
        expect(a.hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });

        const kept = subscribed(await client(a.events).subscribe({ arguments: { k: 2 }, ttlMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(30_000);
        subscribed(await client(b.events).subscribe({ arguments: { k: 2 }, ttlMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await store.get(kept.id)).toBeDefined();
        expect(onA).toHaveBeenCalledOnce();
        expect(onB).not.toHaveBeenCalled();
        expect(a.hook.state().webhookExpiryTimers).toBe(1);

        // At the refreshed grant both replicas look again; one deletes the record and runs onUnsubscribe.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await store.get(kept.id)).toBeUndefined();
        expect(onA.mock.calls.length + onB.mock.calls.length).toBe(2);
        expect(a.hook.state().webhookExpiryTimers + b.hook.state().webhookExpiryTimers).toBe(0);
    });

    it('delivers an emit made on another replica', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const a = replica({ webhookStore: store });
        const b = replica({ webhookStore: store });
        a.events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const handle = b.events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const { id } = subscribed(await client(a.events).subscribe());
        await handle.emit({ eventId: 'evt_1', data: { n: 1 } });
        await b.post.until(1);
        await settle();
        expect(b.post.requests).toHaveLength(1);
        const [delivery] = b.post.requests;
        expect(delivery!.url).toBe(HOOK);
        expect(delivery!.headers['X-MCP-Subscription-Id']).toBe(id);
        expect(bodyOf(delivery!)).toMatchObject({ eventId: 'evt_1', name: 'e', data: { n: 1 }, cursor: expect.any(String) });
        expect(await verifies(delivery!, SECRET)).toBe(true);
        expect(a.post.deliveries()).toEqual([]);
    });

    it('stops retries on A after an unsubscribe on B', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const a = replica({ webhookStore: store, respond: echo(() => ({ status: 500, body: '' })) });
        const b = replica({ webhookStore: store });
        const onA = vi.fn();
        const onB = vi.fn();
        const handle = a.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe: onA });
        b.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe: onB });
        subscribed(await client(a.events).subscribe());
        await handle.emit({ data: { n: 1 } });
        await a.post.until(2);
        await settle();

        resultOf(await client(b.events).unsubscribe());
        expect(onB).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(a.post.requests).toHaveLength(2);
        expect(a.hook.state().webhookSubscriptions).toBe(0);

        // A's timer finds the record gone at the grant and lets it go without a second onUnsubscribe.
        await vi.advanceTimersByTimeAsync(1_800_000);
        expect(a.hook.state().webhookExpiryTimers).toBe(0);
        expect(onA).not.toHaveBeenCalled();
    });

    it('expires a record lazily where no timer watches it, running onUnsubscribe once (F3b)', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const a = replica({ webhookStore: store });
        const b = replica({ webhookStore: store });
        const onSubscribeA = vi.fn();
        const onA = vi.fn();
        const onB = vi.fn();
        a.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe: onSubscribeA, onUnsubscribe: onA });
        const handle = b.events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe: onB });
        const first = subscribed(await client(a.events).subscribe({ arguments: { k: 1 }, ttlMs: 60_000 }));
        const second = subscribed(await client(a.events).subscribe({ arguments: { k: 2 }, ttlMs: 60_000 }));
        // A restarts and loses its timers; the records stay in the store past their grant.
        a.hook.restart();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await stored(store)).toHaveLength(2);

        // Read by a subscribe: the expired record ends, then a fresh one starts.
        subscribed(await client(a.events).subscribe({ arguments: { k: 1 }, ttlMs: 60_000 }));
        expect(onA).toHaveBeenCalledOnce();
        expect(onA.mock.calls[0]![0]).toMatchObject({ subscriptionId: first.id });
        expect(onSubscribeA).toHaveBeenCalledTimes(3);

        // Read by an emit's fan-out on another replica.
        await handle.emit({ data: { n: 1 } });
        await b.post.until(1);
        await settle();
        expect(onB).toHaveBeenCalledOnce();
        const [ctx] = onB.mock.calls[0]! as [EventContext];
        expect(ctx).toMatchObject({ subscriptionId: second.id, mode: 'webhook' });
        expect(ctx.signal.aborted).toBe(true);
        expect((await stored(store)).map(record => record.id)).toEqual([first.id]);

        await handle.emit({ data: { n: 2 } });
        await b.post.until(2);
        await settle();
        expect(onB).toHaveBeenCalledOnce();
        expect(b.post.requests.map(request => request.headers['X-MCP-Subscription-Id'])).toEqual([first.id, first.id]);
    });
});

describe('fan-out', () => {
    it('applies match and transform under each subscription, and a targeted emit reaches only its id', async () => {
        const seen: EventContext[] = [];
        const { events, post } = replica();
        const handle = events.registerEvent('e', {
            emitOnly: true,
            inputSchema: z.object({ min: z.number().optional() }),
            payloadSchema: P,
            match: (ctx, event, args) => {
                seen.push(ctx);
                return event.data.n >= (args.min ?? 0);
            },
            transform: (_ctx, event) => ({ ...event, data: { n: event.data.n * 10 } })
        });
        const alice = client(events);
        const low = subscribed(await alice.subscribe({ arguments: {} }));
        const high = subscribed(await alice.subscribe({ arguments: { min: 5 } }));
        await handle.emit({ eventId: 'small', data: { n: 1 } });
        await post.until(2);
        await settle();
        expect(seen.map(ctx => [ctx.subscriptionId, ctx.principal, ctx.mode])).toEqual([
            [low.id, 'u1', 'webhook'],
            [high.id, 'u1', 'webhook']
        ]);

        await handle.emit({ eventId: 'direct', data: { n: 1 } }, { subscriptionId: high.id });
        await post.until(3);
        await settle();
        expect(seen).toHaveLength(2);
        expect(
            post.deliveries().map(request => [request.headers['X-MCP-Subscription-Id'], bodyOf(request).eventId, bodyOf(request).data])
        ).toEqual([
            [low.id, 'small', { n: 10 }],
            [high.id, 'direct', { n: 10 }]
        ]);
    });
});

describe('check-kind webhook subscriptions', () => {
    it('runs a check loop for a check-kind webhook subscription and stops it on expiry', async () => {
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'c0' })
            .mockReturnValueOnce({ events: [{ eventId: 'evt_1', data: { n: 1 } }], cursor: 'c1' })
            .mockReturnValue({ events: [], cursor: 'c1' });
        const { events, post, hook } = replica();
        events.registerEvent('t', { payloadSchema: P, check });
        const reply = subscribed(await client(events).subscribe({ name: 't', ttlMs: 60_000 }));
        expect(reply).toMatchObject({ cursor: 'c0', truncated: false });
        expect(check).toHaveBeenCalledOnce();
        const [ctx, , cursor] = check.mock.calls[0]!;
        expect(ctx).toMatchObject({ name: 't', subscriptionId: reply.id, principal: 'u1', mode: 'webhook' });
        expect(cursor).toBeNull();

        await vi.advanceTimersByTimeAsync(4999);
        expect(check).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(check.mock.calls[1]![2]).toBe('c0');
        await post.until(2);
        await settle();
        expect(bodyOf(post.requests[1]!)).toMatchObject({ eventId: 'evt_1', name: 't', data: { n: 1 }, cursor: 'c0' });
        await vi.advanceTimersByTimeAsync(5000);
        expect(check.mock.calls[2]![2]).toBe('c1');

        // The grant passes without a refresh: the loop stops.
        await vi.advanceTimersByTimeAsync(50_000);
        const calls = check.mock.calls.length;
        expect(hook.state().webhookExpiryTimers).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(check).toHaveBeenCalledTimes(calls);
        expect(post.requests).toHaveLength(2);
    });

    it('replays from a cursor on create, and sends a gap envelope for a gap between refreshes', async () => {
        const check = vi.fn<Check>((_ctx, _args, cursor) => {
            if (cursor === 'c0') return { events: [{ eventId: 'evt_1', data: { n: 1 } }], cursor: 'c1' };
            if (cursor === 'c1' || cursor === 'old') return { events: [], cursor: 'c5', truncated: true };
            return { events: [], cursor: 'c5' };
        });
        const { events, post } = replica();
        events.registerEvent('t', { payloadSchema: P, check });
        const alice = client(events);
        const replayed = subscribed(await alice.subscribe({ name: 't', arguments: { k: 1 }, cursor: 'c0', maxAgeMs: 300_000 }));
        expect(replayed).toMatchObject({ cursor: 'c0', truncated: false });
        expect(check.mock.calls[0]![0]).toMatchObject({ maxAgeMs: 300_000 });
        await post.until(2);
        await settle();
        expect(bodyOf(post.requests[1]!)).toMatchObject({ eventId: 'evt_1', cursor: 'c0' });

        await vi.advanceTimersByTimeAsync(5000);
        await post.until(3);
        const gap = post.requests[2]!;
        expect(check.mock.calls[1]![0]).not.toHaveProperty('maxAgeMs');
        expect(bodyOf(gap)).toEqual({ type: 'gap', cursor: 'c5' });
        expect(gap.headers).toMatchObject({
            'webhook-id': expect.stringMatching(/^msg_gap_[\w-]+$/),
            'X-MCP-Subscription-Id': replayed.id
        });
        expect(await verifies(gap, SECRET)).toBe(true);

        const gapped = subscribed(await alice.subscribe({ name: 't', arguments: { k: 2 }, cursor: 'old' }));
        expect(gapped).toMatchObject({ cursor: 'c5', truncated: true });
    });

    it('advances the refresh cursor over quiet check batches, never past an unacknowledged event', async () => {
        let acknowledge!: (outcome: WebhookSendOutcome) => void;
        const respond: Respond = request =>
            isVerification(request) ? echo()(request) : new Promise<WebhookSendOutcome>(resolve => (acknowledge = resolve));
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'c0' })
            .mockReturnValueOnce({ events: [], cursor: 'c1' })
            .mockReturnValueOnce({ events: [{ eventId: 'evt_2', data: { n: 2 } }], cursor: 'c2' })
            .mockReturnValueOnce({ events: [], cursor: 'c3' })
            .mockReturnValue({ events: [], cursor: 'c4' });
        const { events, post } = replica({ checkIntervalMs: 100_000, respond });
        events.registerEvent('t', { payloadSchema: P, check });
        const alice = client(events);
        const refreshCursor = async () => subscribed(await alice.subscribe({ name: 't' })).cursor;
        expect(await refreshCursor()).toBe('c0');

        // A quiet batch whose upstream cursor moved.
        await vi.advanceTimersByTimeAsync(100_000);
        expect(await refreshCursor()).toBe('c1');

        // evt_2 waits for its answer, so the next quiet batch leaves the watermark behind it.
        await vi.advanceTimersByTimeAsync(100_000);
        await post.until(2);
        await vi.advanceTimersByTimeAsync(100_000);
        expect(check).toHaveBeenCalledTimes(4);
        expect(await refreshCursor()).toBe('c1');

        // Once evt_2 is acknowledged, the watermark reaches it, and the next quiet batch catches up.
        acknowledge({ status: 200, body: '' });
        await settle();
        expect(await refreshCursor()).toBe('c2');
        await vi.advanceTimersByTimeAsync(100_000);
        expect(await refreshCursor()).toBe('c4');
    });
});

describe('termination', () => {
    it('terminates with a signed envelope and forgets the subscription', async () => {
        const onSubscribe = vi.fn();
        const onUnsubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post, hook } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe, onUnsubscribe });
        const alice = client(events);
        const { id } = subscribed(await alice.subscribe());
        await handle.terminate(new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' }));
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect((onUnsubscribe.mock.calls[0]![0] as EventContext).signal.aborted).toBe(true);
        expect(await store.get(id)).toBeUndefined();
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });

        await post.until(2);
        const terminated = post.requests[1]!;
        expect(bodyOf(terminated)).toEqual({
            type: 'terminated',
            error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } }
        });
        expect(terminated.headers).toMatchObject({
            'webhook-id': expect.stringMatching(/^msg_terminated_[\w-]+$/),
            'X-MCP-Subscription-Id': id
        });
        expect(await verifies(terminated, SECRET)).toBe(true);

        const again = subscribed(await alice.subscribe());
        expect(again.id).toBe(id);
        expect(onSubscribe).toHaveBeenCalledTimes(2);
        expect(post.requests.filter(request => isVerification(request))).toHaveLength(2);
    });

    it('terminates only the subscription with the given subscriptionId, and remove() ends the rest', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const alice = client(events);
        const one = subscribed(await alice.subscribe({ arguments: { k: 1 } }));
        const two = subscribed(await alice.subscribe({ arguments: { k: 2 } }));
        await handle.terminate(new EventsError('forbidden', 'Forbidden'), { subscriptionId: two.id });
        expect((await stored(store)).map(record => record.id)).toEqual([one.id]);
        await post.until(2);
        expect(post.deliveries().map(request => request.headers['X-MCP-Subscription-Id'])).toEqual([two.id]);

        handle.remove();
        await post.until(3);
        await settle();
        expect(bodyOf(post.requests[2]!)).toMatchObject({ type: 'terminated', error: { code: -32_023, data: { kind: 'event' } } });
        expect(post.requests[2]!.headers['X-MCP-Subscription-Id']).toBe(one.id);
        expect(await stored(store)).toEqual([]);
    });

    it('ends a check-kind subscription whose check throws forbidden, and reports other errors', async () => {
        const onerror = vi.fn();
        const onUnsubscribe = vi.fn();
        const check = vi
            .fn<Check>()
            .mockReturnValueOnce({ events: [], cursor: 'c0' })
            .mockImplementationOnce(() => {
                throw new Error('upstream down');
            })
            .mockImplementation(() => {
                throw new EventsError('forbidden', 'Forbidden', { reason: 'Access revoked' });
            });
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post } = replica({ webhookStore: store, onerror });
        events.registerEvent('t', { payloadSchema: P, check, onUnsubscribe });
        const { id } = subscribed(await client(events).subscribe({ name: 't' }));

        await vi.advanceTimersByTimeAsync(5000);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'upstream down' }));
        expect(await store.get(id)).toBeDefined();

        await vi.advanceTimersByTimeAsync(5000);
        await post.until(2);
        await settle();
        expect(bodyOf(post.requests[1]!)).toEqual({
            type: 'terminated',
            error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } }
        });
        expect(await store.get(id)).toBeUndefined();
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(check).toHaveBeenCalledTimes(3);
    });

    it('never makes a subscribe wait on a termination its own onSubscribe awaits', async () => {
        let terminate = true;
        const onUnsubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', {
            emitOnly: true,
            payloadSchema: P,
            onSubscribe: async ctx => {
                if (terminate) await handle.terminate(revoked(), { subscriptionId: ctx.subscriptionId });
            },
            onUnsubscribe
        });
        const alice = client(events);
        expect(errorOf(await alice.subscribe())).toEqual(REVOKED);
        expect(await stored(store)).toEqual([]);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        // Nothing is left holding the line for this subscription.
        terminate = false;
        expect(subscribed(await alice.subscribe()).id).toMatch(SUB_ID);
    });

    it.each(['get', 'put'] as const)('lets no refresh store a record that a termination ended during its %s', async method => {
        const onUnsubscribe = vi.fn();
        const store = new GatedStore();
        const { events, post } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const alice = client(events);
        const { id } = subscribed(await alice.subscribe());

        const gate = store.hold(method);
        const refresh = alice.subscribe();
        await gate.reached;
        await handle.terminate(revoked());
        gate.release();
        expect(errorOf(await refresh)).toEqual(REVOKED);
        expect(await store.get(id)).toBeUndefined();
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        await post.until(2);
        expect(bodyOf(post.requests[1]!)).toEqual({ type: 'terminated', error: REVOKED });

        // The next subscribe starts afresh.
        subscribed(await alice.subscribe());
        expect(await store.get(id)).toBeDefined();
    });

    it('fails a create that a termination reaches while it writes, storing nothing', async () => {
        const onUnsubscribe = vi.fn();
        const store = new GatedStore();
        const { events, post, hook } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P, onUnsubscribe });
        const gate = store.hold('put');
        const creating = client(events).subscribe();
        await gate.reached;
        await handle.terminate(revoked());
        gate.release();
        expect(errorOf(await creating)).toEqual(REVOKED);
        expect(await stored(store)).toEqual([]);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });
        await settle();
        expect(post.deliveries()).toEqual([]);
    });

    it('fails a create that a termination reaches during onSubscribe, storing nothing', async () => {
        let release!: () => void;
        let reached!: () => void;
        const arrived = new Promise<void>(resolve => (reached = resolve));
        const onUnsubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events } = replica({ webhookStore: store });
        const handle = events.registerEvent('e', {
            emitOnly: true,
            payloadSchema: P,
            onSubscribe: () =>
                new Promise<void>(resolve => {
                    release = resolve;
                    reached();
                }),
            onUnsubscribe
        });
        const creating = client(events).subscribe();
        await arrived;
        await handle.terminate(revoked());
        release();
        expect(errorOf(await creating)).toEqual(REVOKED);
        expect(await stored(store)).toEqual([]);
        expect(onUnsubscribe).toHaveBeenCalledOnce();
    });
});

describe('test hook', () => {
    it('drops its webhook state on restart() and keeps the store (F4)', async () => {
        const onSubscribe = vi.fn();
        const store = new InMemoryWebhookSubscriptionStore();
        const { events, post, hook } = replica({ webhookStore: store, respond: echo(() => ({ status: 500, body: '' })) });
        const handle = events.registerEvent('e', { emitOnly: true, payloadSchema: P, onSubscribe });
        const { id } = subscribed(await client(events).subscribe());
        await handle.emit({ data: { n: 1 } });
        await post.until(2);
        await settle();
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 1, webhookExpiryTimers: 1 });

        hook.restart();
        expect(hook.state()).toMatchObject({ webhookSubscriptions: 0, webhookExpiryTimers: 0 });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(post.requests).toHaveLength(2);
        expect(await store.get(id)).toBeDefined();

        // The stored record survives, so the next subscribe refreshes it: no verification, no onSubscribe.
        subscribed(await client(events).subscribe());
        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(post.requests).toHaveLength(2);
        expect(hook.state().webhookExpiryTimers).toBe(1);
    });

    it('admits a callback whose origin the test hook trusted (F5)', async () => {
        const { events, post, hook } = replica();
        events.registerEvent('e', { emitOnly: true, payloadSchema: P });
        const url = 'http://127.0.0.1:9000/hook';
        expect(errorOf(await client(events).subscribe({ url }))).toMatchObject({ code: -32_602 });
        hook.addTrustedOrigin('http://127.0.0.1:9000');
        subscribed(await client(events).subscribe({ url }));
        expect(post.requests.map(request => [request.url, request.trusted])).toEqual([[url, true]]);
    });
});
