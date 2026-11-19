import type { EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { WebhookControlBodySchema } from '@modelcontextprotocol/core/ext/events';
import {
    EventsError,
    generateWebhookSecret,
    parseWebhookSecret,
    verifyWebhookSignature
} from '@modelcontextprotocol/core-internal/ext/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    WebhookSendOutcome,
    WebhookSendRequest,
    WebhookSubscriptionRecord,
    WebhookSubscriptionStore
} from '../../../src/ext/events/types';
import { WebhookEngine } from '../../../src/ext/events/webhookEngine';

const HOOK_URL = 'https://hooks.example.com/mcp';
const ID = 'sub_1';
const SECRET = generateWebhookSecret();
const MESSAGE_ID = /^msg_[\w-]+$/;
const DELAYS = [5000, 30_000, 120_000, 300_000];

type Respond = (request: WebhookSendRequest) => WebhookSendOutcome | Promise<WebhookSendOutcome>;

interface Sent extends WebhookSendRequest {
    readonly at: number;
}

class MapStore implements WebhookSubscriptionStore {
    readonly records = new Map<string, WebhookSubscriptionRecord>();
    get(id: string): Promise<WebhookSubscriptionRecord | undefined> {
        return Promise.resolve(this.records.get(id));
    }
    put(record: WebhookSubscriptionRecord): Promise<void> {
        this.records.set(record.id, record);
        return Promise.resolve();
    }
    delete(id: string): Promise<boolean> {
        return Promise.resolve(this.records.delete(id));
    }
    async *listByName(name: string): AsyncIterable<WebhookSubscriptionRecord> {
        for (const record of this.records.values()) if (record.name === name) yield record;
    }
}

const ok: Respond = () => ({ status: 200, body: '' });

// Answers a verification challenge by echoing it, and anything else with 200.
const echo: Respond = request => {
    const body = JSON.parse(request.body) as { type?: string; challenge?: string };
    return { status: 200, body: body.type === 'verification' ? JSON.stringify({ challenge: body.challenge }) : '' };
};

const engines: WebhookEngine[] = [];

function occurrence(eventId: string, data?: Record<string, unknown>): EventOccurrence {
    return { eventId, name: 'e', timestamp: '2026-11-18T00:00:00.000Z', data: data ?? { n: 1 } };
}

function recordFor(overrides: Partial<WebhookSubscriptionRecord> = {}): WebhookSubscriptionRecord {
    return {
        id: ID,
        principal: 'u',
        name: 'e',
        arguments: {},
        url: HOOK_URL,
        secret: SECRET,
        expiresAt: Date.now() + 3_600_000,
        createdAt: Date.now(),
        ...overrides
    };
}

// An engine over a store holding `recordFor()`, with a sender that records each request and answers with `respond`.
function setup(respond: Respond = ok, trustedOrigins: Set<string> = new Set()) {
    const store = new MapStore();
    const record = recordFor();
    store.records.set(record.id, record);
    const requests: Sent[] = [];
    const waiters: Array<{ count: number; resolve(): void }> = [];
    const sender = vi.fn((request: WebhookSendRequest): Promise<WebhookSendOutcome> => {
        requests.push({ ...request, at: Date.now() });
        for (const waiter of waiters.filter(w => requests.length >= w.count)) waiter.resolve();
        return Promise.resolve(respond(request));
    });
    // Resolves once `count` requests were sent; signing runs off the fake clock, so tests wait for sends.
    const until = (count: number): Promise<void> =>
        new Promise(resolve => {
            if (requests.length >= count) resolve();
            else waiters.push({ count, resolve });
        });
    const onerror = vi.fn();
    const engine = new WebhookEngine({ sender, store, trustedOrigins, onerror });
    engines.push(engine);
    return { engine, store, record, sender, requests, until, onerror };
}

// Lets the engine act on answers already received, without moving the clock.
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

function verifies(request: WebhookSendRequest, secret: string): Promise<boolean> {
    const headers = request.headers;
    return verifyWebhookSignature(
        [parseWebhookSecret(secret)!],
        headers['webhook-id']!,
        Number(headers['webhook-timestamp']),
        request.body,
        headers['webhook-signature']!
    );
}

function bodyOf(request: WebhookSendRequest): Record<string, unknown> {
    return JSON.parse(request.body) as Record<string, unknown>;
}

// Delivers events `from` to `to` (at positions p{from} to p{to}) to a receiver that fails them, and moves the clock through all five
// attempts of each, ten at a time, until the last is abandoned; `sent` counts the requests before, and the count after is returned.
async function failThrough(
    engine: WebhookEngine,
    record: WebhookSubscriptionRecord,
    until: (count: number) => Promise<void>,
    sent: number,
    from: number,
    to: number
): Promise<number> {
    for (let n = from; n <= to; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
    for (let left = to - from + 1; left > 0; left -= 10) {
        const batch = Math.min(10, left);
        sent += batch;
        await until(sent);
        for (const delay of DELAYS) {
            await settle();
            await vi.advanceTimersByTimeAsync(delay);
            sent += batch;
            await until(sent);
        }
        await settle();
    }
    return sent;
}

// A responder that holds each event POST until the test answers it, counting how many are in flight at most.
function held() {
    const answers: Array<() => void> = [];
    let inFlight = 0;
    let most = 0;
    const respond: Respond = () =>
        new Promise(resolve => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            answers.push(() => {
                inFlight -= 1;
                resolve({ status: 200, body: '' });
            });
        });
    return { respond, answers, most: () => most };
}

// The body cursor of each event POST by eventId; signing is asynchronous, so the sends need not come in delivery order.
function cursorsByEvent(requests: WebhookSendRequest[]): Record<string, unknown> {
    return Object.fromEntries(requests.map(request => [bodyOf(request).eventId, bodyOf(request).cursor]));
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    for (const engine of engines.splice(0)) engine.clear();
    vi.useRealTimers();
});

describe('endpoint verification', () => {
    it('verifies with a signed challenge and caches per principal and url', async () => {
        const { engine, requests } = setup(echo);
        await engine.verify('u', HOOK_URL, SECRET, ID);
        expect(requests).toHaveLength(1);
        const [request] = requests;
        expect(bodyOf(request!)).toEqual({ type: 'verification', challenge: expect.stringMatching(/^[\w-]{43}$/) });
        expect(request!.headers).toMatchObject({
            'Content-Type': 'application/json',
            'webhook-id': expect.stringMatching(/^msg_verification_[\w-]+$/),
            'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
            'X-MCP-Subscription-Id': ID
        });
        expect(await verifies(request!, SECRET)).toBe(true);

        await engine.verify('u', HOOK_URL, SECRET, 'sub_2');
        expect(requests).toHaveLength(1);
        await engine.verify('v', HOOK_URL, SECRET, 'sub_3');
        expect(requests).toHaveLength(2);
        expect(bodyOf(requests[1]!).challenge).not.toBe(bodyOf(request!).challenge);
    });

    const failures: Array<[WebhookSendOutcome, string]> = [
        [{ status: 200, body: '{"challenge":"wrong"}' }, 'challenge_failed'],
        [{ status: 200, body: 'not json' }, 'challenge_failed'],
        [{ status: 404, body: '' }, 'challenge_failed'],
        [{ error: 'connection_refused' }, 'connection_refused'],
        [{ error: 'timeout' }, 'timeout'],
        [{ error: 'tls_error' }, 'tls_error']
    ];
    it.each(failures)('fails verification with %o as %s, and answers it again without a POST for 60 s', async (outcome, reason) => {
        const { engine, requests } = setup(() => outcome);
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toMatchObject({ code: -32_027, data: { reason } });
        await vi.advanceTimersByTimeAsync(59_999);
        await expect(engine.verify('u', HOOK_URL, SECRET, 'sub_2')).rejects.toMatchObject({ code: -32_027, data: { reason } });
        expect(requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toBeInstanceOf(EventsError);
        expect(requests).toHaveLength(2);
    });

    it('caches a failure per principal and url', async () => {
        const { engine, requests } = setup(request => (request.url === HOOK_URL ? { error: 'connection_refused' } : echo(request)));
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toMatchObject({ data: { reason: 'connection_refused' } });
        await engine.verify('u', `${HOOK_URL}/other`, SECRET, 'sub_2');
        await expect(engine.verify('v', HOOK_URL, SECRET, 'sub_3')).rejects.toMatchObject({ data: { reason: 'connection_refused' } });
        expect(requests).toHaveLength(3);
    });

    it('still caches a success: later subscriptions of the pair send no POST and never reach the host limit', async () => {
        const { engine, requests } = setup(echo);
        await engine.verify('u', HOOK_URL, SECRET, ID);
        for (let n = 2; n <= 20; n++) await engine.verify('u', HOOK_URL, SECRET, `sub_${n}`);
        expect(requests).toHaveLength(1);
    });

    it('sends one verification POST to a host at a time: another pair waits its turn', async () => {
        const answers: Array<() => void> = [];
        const { engine, requests, until } = setup(
            request => new Promise(resolve => answers.push(() => resolve(echo(request) as WebhookSendOutcome)))
        );
        const first = engine.verify('u', HOOK_URL, SECRET, ID);
        await until(1);
        // The same pair waits for the handshake in flight; another pair to that host waits its turn; another host does not wait.
        const samePair = engine.verify('u', HOOK_URL, SECRET, 'sub_2');
        const otherPair = engine.verify('v', 'https://HOOKS.example.com/other', SECRET, 'sub_3');
        const otherHost = engine.verify('v', 'https://elsewhere.example.com/mcp', SECRET, 'sub_4');
        await until(2);
        await settle();
        expect(requests.map(request => request.url)).toEqual([HOOK_URL, 'https://elsewhere.example.com/mcp']);

        answers[0]!();
        await expect(Promise.all([first, samePair])).resolves.toEqual([undefined, undefined]);
        await until(3);
        expect(requests[2]!.url).toBe('https://HOOKS.example.com/other');
        answers[1]!();
        answers[2]!();
        await expect(Promise.all([otherPair, otherHost])).resolves.toEqual([undefined, undefined]);
        expect(requests).toHaveLength(3);
    });

    it('refuses a verification at once when 10 already wait for the host', async () => {
        const answers: Array<() => void> = [];
        const { engine, requests, until } = setup(
            request => new Promise(resolve => answers.push(() => resolve(echo(request) as WebhookSendOutcome)))
        );
        const outcome = (n: number) =>
            engine.verify(`u${n}`, HOOK_URL, SECRET, `sub_${n}`).then(
                () => 'verified',
                (error: unknown) => error
            );
        const waiting = [outcome(0)];
        await until(1);
        for (let n = 1; n <= 10; n++) waiting.push(outcome(n));
        await expect(engine.verify('u11', HOOK_URL, SECRET, 'sub_11')).rejects.toMatchObject({
            code: -32_025,
            data: { limit: 'verification', retryAfterMs: 5000 }
        });

        // They go one at a time; the window's limit refuses the 11th POST in 60 s when its turn comes.
        for (let n = 1; n <= 10; n++) {
            answers[n - 1]!();
            await until(Math.min(n + 1, 10));
            await settle();
        }
        answers[9]!();
        const outcomes = await Promise.all(waiting);
        expect(outcomes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 'verified'));
        expect(outcomes[10]).toMatchObject({ code: -32_025, data: { limit: 'verification', retryAfterMs: 60_000 } });
        expect(requests).toHaveLength(10);
    });

    it('takes a queued verification whose subscribe is cancelled out of the queue at once, without a POST', async () => {
        const answers: Array<() => void> = [];
        const { engine, requests, until } = setup(
            request => new Promise(resolve => answers.push(() => resolve(echo(request) as WebhookSendOutcome)))
        );
        const first = engine.verify('u0', HOOK_URL, SECRET, 'sub_0');
        await until(1);
        const cancel = new AbortController();
        const cancelled = engine.verify('u1', HOOK_URL, SECRET, 'sub_1', cancel.signal).catch((error: unknown) => error);
        // Another subscribe of a pair keeps that pair's handshake queued when one of its callers is cancelled.
        const sharedCancel = new AbortController();
        const sharedLeaving = engine.verify('u2', HOOK_URL, SECRET, 'sub_2', sharedCancel.signal).catch((error: unknown) => error);
        const sharedStaying = engine.verify('u2', HOOK_URL, SECRET, 'sub_3');
        const reason = new Error('request cancelled');
        cancel.abort(reason);
        sharedCancel.abort(reason);
        expect(await cancelled).toBe(reason);
        expect(await sharedLeaving).toBe(reason);

        answers[0]!();
        await first;
        await until(2);
        expect(requests[1]!.headers['X-MCP-Subscription-Id']).toBe('sub_2');
        answers[1]!();
        await expect(sharedStaying).resolves.toBeUndefined();
        await settle();
        expect(requests).toHaveLength(2);
    });

    it('rejects the verifications waiting for a host on clear()', async () => {
        const { engine, until } = setup(() => new Promise<never>(() => {}));
        void engine.verify('u', HOOK_URL, SECRET, ID).catch(() => {});
        await until(1);
        const waiting = engine.verify('v', HOOK_URL, SECRET, 'sub_2');
        engine.clear();
        await expect(waiting).rejects.toMatchObject({ code: -32_025, data: { limit: 'verification' } });
    });

    it('sends at most 10 verification POSTs to a host per rolling 60 s', async () => {
        const { engine, requests } = setup(echo);
        for (let n = 1; n <= 10; n++) {
            await engine.verify(`u${n}`, HOOK_URL, SECRET, `sub_${n}`);
            await vi.advanceTimersByTimeAsync(1000);
        }
        await expect(engine.verify('u11', 'https://Hooks.Example.com/mcp', SECRET, 'sub_11')).rejects.toMatchObject({
            code: -32_025,
            data: { limit: 'verification', retryAfterMs: 50_000 }
        });
        await engine.verify('u11', 'https://elsewhere.example.com/mcp', SECRET, 'sub_12');
        expect(requests).toHaveLength(11);

        await vi.advanceTimersByTimeAsync(50_000);
        await engine.verify('u11', HOOK_URL, SECRET, 'sub_11');
        expect(requests).toHaveLength(12);
    });

    it('fails verification when a 404 echoes the challenge', async () => {
        const { engine } = setup(request => ({ status: 404, body: JSON.stringify({ challenge: bodyOf(request).challenge }) }));
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toMatchObject({ data: { reason: 'challenge_failed' } });
    });

    it('verifies a trusted origin too, and reads the live trusted set (D24, F5)', async () => {
        const trustedOrigins = new Set(['http://127.0.0.1:9000']);
        const { engine, record, requests, until } = setup(echo, trustedOrigins);
        await engine.verify('u', 'http://127.0.0.1:9000/hook', SECRET, ID);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.trusted).toBe(true);

        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(2);
        expect(requests[1]!.trusted).toBe(false);
        trustedOrigins.add('https://hooks.example.com');
        engine.deliver(record, occurrence('evt_2'), 'p2', 'p1');
        await until(3);
        expect(requests[2]!.trusted).toBe(true);
    });
});

describe('event delivery', () => {
    it('signs the raw body and keeps webhook-id across retries', async () => {
        let answer: WebhookSendOutcome = { status: 500, body: '' };
        const { engine, record, requests, until } = setup(() => answer);
        engine.track(ID, 'p0');
        engine.deliver(record, occurrence('evt_1'), 'p1', null);
        await until(1);
        await settle();
        answer = { status: 200, body: '' };
        await vi.advanceTimersByTimeAsync(5000);
        await until(2);

        const [first, second] = requests;
        expect(first!.headers['webhook-id']).toMatch(MESSAGE_ID);
        expect(second!.headers['webhook-id']).toBe(first!.headers['webhook-id']);
        expect(Number(second!.headers['webhook-timestamp']) - Number(first!.headers['webhook-timestamp'])).toBe(5);
        expect(second!.headers['webhook-signature']).not.toBe(first!.headers['webhook-signature']);
        for (const request of requests) {
            expect(request.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-MCP-Subscription-Id': ID });
            expect(await verifies(request, SECRET)).toBe(true);
            // Nothing before it is unsettled, so it carries its own position.
            expect(bodyOf(request)).toEqual({ ...occurrence('evt_1'), cursor: 'p1' });
        }
    });

    it('gives each message its own webhook-id, never derived from eventId', async () => {
        const { engine, store, record, requests, until } = setup();
        const other = recordFor({ id: 'sub_2' });
        await store.put(other);
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        engine.deliver(other, occurrence('evt_1'), 'p1', 'p0');
        await until(2);
        const ids = requests.map(request => request.headers['webhook-id']!);
        expect(new Set(ids).size).toBe(2);
        for (const id of ids) {
            expect(id).toMatch(MESSAGE_ID);
            expect(id).not.toContain('evt_1');
        }
    });

    it('retries on the documented schedule then abandons', async () => {
        const { engine, record, requests, until } = setup(() => ({ status: 503, body: '' }));
        const start = Date.now();
        engine.track(ID, 'p0');
        engine.deliver(record, occurrence('evt_1'), 'p1', null);
        await until(1);
        for (const [index, delay] of DELAYS.entries()) {
            await settle();
            await vi.advanceTimersByTimeAsync(delay);
            await until(index + 2);
        }
        await settle();

        expect(requests.map(request => request.at - start)).toEqual([0, 5000, 35_000, 155_000, 455_000]);
        expect(new Set(requests.map(request => request.headers['webhook-id'])).size).toBe(1);
        expect(engine.watermark(ID)).toBe('p1');
        expect(engine.status(ID)).toMatchObject({ active: true, lastError: 'http_5xx' });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(requests).toHaveLength(5);
    });

    it.each([410, 413])('treats %i as final for the message', async status => {
        const { engine, store, record, requests, until } = setup(() => ({ status, body: '' }));
        const put = vi.spyOn(store, 'put');
        const remove = vi.spyOn(store, 'delete');
        engine.track(ID, 'p0');
        engine.deliver(record, occurrence('evt_1'), 'p1', null);
        await until(1);
        await settle();

        expect(engine.watermark(ID)).toBe('p1');
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: null, lastError: 'http_4xx' });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(1);
        expect(store.records.get(ID)).toBe(record);
        expect(put).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });

    it('records a hanging receiver as timeout and retries (Review Focus 3)', async () => {
        // Like a sender whose request timer fires: no answer for 5 s, then `timeout`.
        let hang = true;
        const { engine, record, requests, until } = setup(() =>
            hang ? new Promise(resolve => setTimeout(() => resolve({ error: 'timeout' }), 5000)) : { status: 204, body: '' }
        );
        const start = Date.now();
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(engine.status(ID)).toEqual({
            active: true,
            lastDeliveryAt: null,
            lastError: 'timeout',
            failedSince: new Date(start + 5000).toISOString()
        });
        expect(engine.watermark(ID)).toBe('p0');

        hang = false;
        await vi.advanceTimersByTimeAsync(4999);
        expect(requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await until(2);
        await settle();
        expect(requests[1]!.at - start).toBe(10_000);
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: new Date(start + 10_000).toISOString(), lastError: null });
        expect(engine.watermark(ID)).toBe('p1');
    });

    it('holds the watermark behind an unacknowledged event, and sends an event its own position once nothing before it is unsettled (SEP-3415)', async () => {
        let failFirst = true;
        const { engine, record, requests, until } = setup(request =>
            failFirst && bodyOf(request).eventId === 'evt_1' ? { status: 500, body: '' } : { status: 200, body: '' }
        );
        engine.track(ID, 'p0');
        engine.deliver(record, occurrence('evt_1'), 'p1', null);
        engine.deliver(record, occurrence('evt_2'), 'p2', null);
        engine.deliver(record, occurrence('evt_3'), 'p3', null);
        await until(3);
        await settle();
        expect(engine.watermark(ID)).toBe('p0');
        // The first carries its own position; the others, behind it while it is unsettled, the watermark.
        expect(cursorsByEvent(requests)).toEqual({ evt_1: 'p1', evt_2: 'p0', evt_3: 'p0' });

        failFirst = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(4);
        await settle();
        expect(engine.watermark(ID)).toBe('p3');

        expect(bodyOf(requests[3]!).cursor).toBe('p1');
        engine.deliver(record, occurrence('evt_4'), 'p4', null);
        await until(5);
        expect(bodyOf(requests[4]!).cursor).toBe('p4');
    });

    it('advance() moves an idle watermark, and is ignored while a message is pending', async () => {
        let answer: WebhookSendOutcome = { status: 500, body: '' };
        const { engine, record, requests, until } = setup(() => answer);
        engine.advance(ID, 'p9');
        expect(engine.watermark(ID)).toBeUndefined();
        engine.track(ID, 'p0');
        engine.advance(ID, 'p1');
        expect(engine.watermark(ID)).toBe('p1');

        engine.deliver(record, occurrence('evt_2'), 'p2', null);
        await until(1);
        await settle();
        engine.advance(ID, 'p5');
        expect(engine.watermark(ID)).toBe('p1');

        answer = { status: 200, body: '' };
        await vi.advanceTimersByTimeAsync(5000);
        await until(2);
        await settle();
        expect(engine.watermark(ID)).toBe('p2');
        expect(bodyOf(requests[1]!).cursor).toBe('p2');
        engine.advance(ID, 'p5');
        expect(engine.watermark(ID)).toBe('p5');
    });

    it('tracks an unknown subscription from the seed, so every POST carries a cursor (F3a)', async () => {
        const { engine, record, requests, until } = setup();
        expect(engine.watermark(ID)).toBeUndefined();
        expect(engine.status(ID)).toBeUndefined();
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        engine.deliver(record, occurrence('evt_2'), 'p2', 'p1');
        await until(2);
        await settle();
        expect(cursorsByEvent(requests)).toEqual({ evt_1: 'p1', evt_2: 'p0' });
        expect(engine.watermark(ID)).toBe('p2');
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: new Date().toISOString(), lastError: null });
    });

    it('sends cursor null for an event type without replay', async () => {
        const { engine, record, requests, until } = setup();
        engine.deliver(record, occurrence('evt_1'), null, null);
        await until(1);
        await settle();
        expect(bodyOf(requests[0]!)).toHaveProperty('cursor', null);
        expect(engine.watermark(ID)).toBeNull();
    });

    it('has at most 10 messages of a subscription in flight, a retry wait included, and starts the rest in position order', async () => {
        let failing = true;
        const hold = held();
        const { engine, record, requests, until } = setup(request =>
            failing && bodyOf(request).eventId === 'evt_1' ? { status: 503, body: '' } : hold.respond(request)
        );
        engine.track(ID, 'p0');
        for (let n = 1; n <= 25; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(10);
        await settle();
        expect(requests).toHaveLength(10);
        // evt_1 keeps its slot while it waits for its retry; each other answer frees a slot for the next message.
        for (let n = 0; n < 9; n++) {
            hold.answers[n]!();
            await until(11 + n);
        }
        await settle();
        expect(requests).toHaveLength(19);
        expect(requests.slice(10).map(request => bodyOf(request).eventId)).toEqual(Array.from({ length: 9 }, (_, n) => `evt_${11 + n}`));
        expect(engine.watermark(ID)).toBe('p0');

        failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(20);
        // Each answer frees a slot for the next message, which starts before the next answer.
        for (let n = 9; n < 25; n++) {
            hold.answers[n]!();
            await until(Math.min(n + 12, 26));
        }
        await settle();
        expect(requests).toHaveLength(26);
        expect(requests.slice(20).map(request => bodyOf(request).eventId)).toEqual(Array.from({ length: 6 }, (_, n) => `evt_${20 + n}`));
        expect(hold.most()).toBe(10);
        expect(engine.watermark(ID)).toBe('p25');
    });

    it('queues each delivery and returns without waiting for the receiver', async () => {
        const answers = new Map<string, (outcome: WebhookSendOutcome) => void>();
        const { engine, record, until } = setup(request => new Promise(resolve => answers.set(bodyOf(request).eventId as string, resolve)));
        expect(engine.deliver(record, occurrence('evt_1'), 'p1', 'p0')).toBeUndefined();
        expect(engine.deliver(record, occurrence('evt_2'), 'p2', 'p0')).toBeUndefined();
        await until(2);
        answers.get('evt_2')!({ status: 200, body: '' });
        await settle();
        expect(engine.watermark(ID)).toBe('p0');
        answers.get('evt_1')!({ status: 200, body: '' });
        await settle();
        expect(engine.watermark(ID)).toBe('p2');
    });

    it('dual-signs during the rotation grace window', async () => {
        const previous = generateWebhookSecret();
        const { engine, store, record, requests, until } = setup();
        const rotated = { ...record, previousSecret: { secret: previous, expiresAt: Date.now() + 300_000 } };
        await store.put(rotated);
        engine.deliver(rotated, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        const signatures = requests[0]!.headers['webhook-signature']!.split(' ');
        expect(signatures).toHaveLength(2);
        expect(signatures.every(signature => signature.startsWith('v1,'))).toBe(true);
        expect(await verifies(requests[0]!, SECRET)).toBe(true);
        expect(await verifies(requests[0]!, previous)).toBe(true);

        await vi.advanceTimersByTimeAsync(300_000);
        engine.deliver(rotated, occurrence('evt_2'), 'p2', 'p1');
        await until(2);
        expect(requests[1]!.headers['webhook-signature']!.split(' ')).toHaveLength(1);
        expect(await verifies(requests[1]!, SECRET)).toBe(true);
        expect(await verifies(requests[1]!, previous)).toBe(false);
    });

    it('signs each retry with the record as the store holds it then', async () => {
        let answer: WebhookSendOutcome = { status: 500, body: '' };
        const { engine, store, record, requests, until } = setup(() => answer);
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        const next = generateWebhookSecret();
        await store.put({ ...record, secret: next, previousSecret: { secret: SECRET, expiresAt: Date.now() + 300_000 } });
        answer = { status: 200, body: '' };
        await vi.advanceTimersByTimeAsync(5000);
        await until(2);
        expect(requests[1]!.headers['webhook-signature']!.split(' ')).toHaveLength(2);
        expect(await verifies(requests[1]!, next)).toBe(true);
    });

    it.each(['deleted', 'expired'])('stops retrying once the record is %s', async change => {
        const { engine, store, record, requests, until } = setup(() => ({ status: 500, body: '' }));
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        await (change === 'deleted' ? store.delete(ID) : store.put({ ...record, expiresAt: Date.now() + 4000 }));
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(1);
        expect(engine.watermark(ID)).toBeUndefined();
    });

    it('never sends a body over 256 KiB', async () => {
        const { engine, record, requests, until, onerror } = setup();
        const empty = JSON.stringify({ ...occurrence('evt_max', { blob: '' }), cursor: 'p0' });
        engine.deliver(record, occurrence('evt_max', { blob: 'x'.repeat(262_144 - empty.length) }), 'p1', 'p0');
        await until(1);
        expect(new TextEncoder().encode(requests[0]!.body).byteLength).toBe(262_144);

        // 131 072 two-byte characters: under the cap in UTF-16 code units, over it in UTF-8 bytes.
        engine.deliver(record, occurrence('evt_big', { blob: 'é'.repeat(131_072) }), 'p2', 'p1');
        await settle();
        expect(requests).toHaveLength(1);
        expect(onerror).toHaveBeenCalledTimes(1);
        expect(onerror.mock.calls[0]![0]).toBeInstanceOf(Error);
        expect((onerror.mock.calls[0]![0] as Error).message).toContain('262144');
        expect(engine.watermark(ID)).toBe('p2');
    });

    it('reports a sender that throws and retries the message', async () => {
        let fail = true;
        const { engine, record, until, onerror } = setup(() => {
            if (fail) throw new Error('sender broke');
            return { status: 200, body: '' };
        });
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'sender broke' }));
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
        fail = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(2);
        await settle();
        expect(engine.watermark(ID)).toBe('p1');
    });
});

describe('delivery status', () => {
    const categories: Array<[WebhookSendOutcome, string]> = [
        [{ error: 'connection_refused' }, 'connection_refused'],
        [{ error: 'tls_error' }, 'tls_error'],
        [{ status: 302, body: '' }, 'http_4xx'],
        [{ status: 404, body: 'not here' }, 'http_4xx'],
        [{ status: 500, body: 'oops' }, 'http_5xx']
    ];
    it.each(categories)('reports %o as lastError %s', async (outcome, category) => {
        const { engine, record, until } = setup(() => outcome);
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        expect(engine.status(ID)).toEqual({
            active: true,
            lastDeliveryAt: null,
            lastError: category,
            failedSince: new Date().toISOString()
        });
    });

    it('suspends when more than 95 % of at least 100 attempts in the last hour failed, and resume() retries what waited', async () => {
        let healthy = false;
        const { engine, record, requests, until } = setup(request =>
            healthy || Number((bodyOf(request).eventId as string).slice(4)) <= 5 ? { status: 200, body: '' } : { status: 503, body: '' }
        );
        const start = Date.now();
        engine.track(ID, 'p0');
        for (let n = 1; n <= 5; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(5);
        await settle();
        // 19 events abandoned after five failed attempts each: 95 of 100 attempts failed, not more than 95 %.
        expect(await failThrough(engine, record, until, 5, 6, 24)).toBe(100);
        expect(engine.status(ID)).toMatchObject({ active: true });
        expect(engine.watermark(ID)).toBe('p24');

        engine.deliver(record, occurrence('evt_25'), 'p25', null);
        await until(101);
        await settle();
        expect(engine.status(ID)).toEqual({
            active: false,
            lastDeliveryAt: new Date(start).toISOString(),
            lastError: 'http_5xx',
            failedSince: new Date(start).toISOString()
        });

        // evt_25's retry and evt_26 wait for the resume.
        engine.deliver(record, occurrence('evt_26'), 'p26', null);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(101);
        expect(engine.watermark(ID)).toBe('p24');

        healthy = true;
        engine.resume(ID);
        await until(103);
        await settle();
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: new Date().toISOString(), lastError: null });
        expect(engine.watermark(ID)).toBe('p26');
    });

    it('counts only the attempts of the last 60 minutes', async () => {
        let failing = true;
        const { engine, store, until } = setup(() => (failing ? { status: 503, body: '' } : { status: 200, body: '' }));
        const record = recordFor({ expiresAt: Date.now() + 86_400_000 });
        await store.put(record);
        engine.track(ID, 'p0');
        for (let n = 1; n <= 10; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(10);
        await settle();
        failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(20);
        await settle();
        expect(engine.watermark(ID)).toBe('p10');

        // Counted with the hour before, these would be 110 failures in 120 attempts, not more than 95 %; alone they are 100 in 100.
        await vi.advanceTimersByTimeAsync(3_600_000);
        failing = true;
        await failThrough(engine, record, until, 20, 11, 30);
        expect(engine.status(ID)).toMatchObject({ active: false });
    });

    it('holds at most 10 000 messages while suspended, abandoning the oldest', async () => {
        let healthy = false;
        const { engine, record, requests, until } = setup(() => (healthy ? { status: 200, body: '' } : { status: 503, body: '' }));
        engine.track(ID, 'p0');
        // 20 events, five failed attempts each: the 100th attempt suspends delivery as the last retries give up.
        await failThrough(engine, record, until, 0, 1, 20);
        expect(engine.status(ID)).toMatchObject({ active: false });
        expect(engine.watermark(ID)).toBe('p20');

        for (let n = 21; n <= 10_021; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        expect(engine.watermark(ID)).toBe('p21');
        expect(requests).toHaveLength(100);

        healthy = true;
        engine.resume(ID);
        await until(100 + 10_000);
        await settle();
        expect(requests).toHaveLength(100 + 10_000);
        expect(requests.some(request => bodyOf(request).eventId === 'evt_21')).toBe(false);
        expect(engine.watermark(ID)).toBe('p10021');
    });

    it.each(['a due retry', 'a new delivery'])('releases a suspended subscription whose record expired, on %s', async path => {
        const { engine, store, record, requests, until } = setup(() => ({ status: 503, body: '' }));
        engine.track(ID, 'p0');
        // 95 failed attempts, then five first attempts that fail: the 100th suspends delivery while their retries are due.
        const sent = await failThrough(engine, record, until, 0, 1, 19);
        for (let n = 20; n <= 24; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(sent + 5);
        await settle();
        expect(engine.status(ID)).toMatchObject({ active: false });

        const expired = { ...record, expiresAt: Date.now() + 1000 };
        await store.put(expired);
        if (path === 'a due retry') await vi.advanceTimersByTimeAsync(5000);
        else {
            await vi.advanceTimersByTimeAsync(1000);
            engine.deliver(expired, occurrence('evt_101'), 'p101', null);
        }
        await settle();
        expect(engine.size).toBe(0);
        expect(engine.watermark(ID)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
        expect(requests).toHaveLength(100);
    });

    it('resumes many parked messages at most 10 in flight, in position order', async () => {
        let healthy = false;
        const hold = held();
        const { engine, record, requests, until } = setup(request => (healthy ? hold.respond(request) : { status: 503, body: '' }));
        engine.track(ID, 'p0');
        await failThrough(engine, record, until, 0, 1, 20);
        expect(engine.status(ID)).toMatchObject({ active: false });
        for (let n = 21; n <= 50; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        expect(requests).toHaveLength(100);

        healthy = true;
        engine.resume(ID);
        await until(110);
        await settle();
        expect(requests).toHaveLength(110);
        // Each answer frees a slot for the next message waiting.
        for (let n = 0; n < 30; n++) {
            hold.answers[n]!();
            await until(Math.min(111 + n, 130));
        }
        await settle();
        const resumed = requests.slice(100).map(request => bodyOf(request).eventId);
        expect(resumed.slice(0, 10).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `evt_${21 + n}`).sort());
        expect(resumed.slice(10)).toEqual(Array.from({ length: 20 }, (_, n) => `evt_${31 + n}`));
        expect(hold.most()).toBe(10);
        expect(engine.watermark(ID)).toBe('p50');
    });

    it('resume() does nothing for an active or unknown subscription', async () => {
        const { engine, record, requests, until } = setup();
        engine.resume(ID);
        expect(engine.status(ID)).toBeUndefined();
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        engine.resume(ID);
        await settle();
        expect(requests).toHaveLength(1);
        expect(engine.status(ID)).toMatchObject({ active: true });
    });
});

describe('control bodies', () => {
    it('sends gap and terminated control bodies', async () => {
        const { engine, record, requests } = setup(() => ({ status: 202, body: '' }));
        expect(await engine.sendControl(record, { type: 'gap', cursor: 'p9' })).toEqual({ status: 202, body: '' });
        expect(await engine.sendControl(record, { type: 'terminated', error: { code: -32_024, message: 'Forbidden' } })).toEqual({
            status: 202,
            body: ''
        });

        expect(requests.map(request => request.headers['webhook-id'])).toEqual([
            expect.stringMatching(/^msg_gap_[\w-]+$/),
            expect.stringMatching(/^msg_terminated_[\w-]+$/)
        ]);
        expect(bodyOf(requests[0]!)).toEqual({ type: 'gap', cursor: 'p9' });
        for (const request of requests) {
            expect(WebhookControlBodySchema.safeParse(bodyOf(request)).success).toBe(true);
            expect(request.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-MCP-Subscription-Id': ID });
            expect(await verifies(request, SECRET)).toBe(true);
        }
    });

    it('retries a control body under one webhook-id, with a fresh timestamp and signature', async () => {
        let answer: WebhookSendOutcome = { status: 503, body: '' };
        const { engine, record, requests, until } = setup(() => answer);
        const outcome = engine.sendControl(record, { type: 'terminated', error: { code: -32_024, message: 'Forbidden' } });
        await until(1);
        await settle();
        answer = { status: 200, body: '' };
        await vi.advanceTimersByTimeAsync(5000);
        await until(2);
        expect(await outcome).toEqual({ status: 200, body: '' });

        const [first, second] = requests;
        expect(second!.headers['webhook-id']).toBe(first!.headers['webhook-id']);
        expect(Number(second!.headers['webhook-timestamp']) - Number(first!.headers['webhook-timestamp'])).toBe(5);
        expect(second!.headers['webhook-signature']).not.toBe(first!.headers['webhook-signature']);
        for (const request of requests) expect(await verifies(request, SECRET)).toBe(true);
    });

    it('resolves with the last answer once the retries run out', async () => {
        const { engine, record, requests, until } = setup(() => ({ error: 'connection_refused' }));
        const outcome = engine.sendControl(record, { type: 'gap', cursor: null });
        await until(1);
        for (const [index, delay] of DELAYS.entries()) {
            await settle();
            await vi.advanceTimersByTimeAsync(delay);
            await until(index + 2);
        }
        expect(await outcome).toEqual({ error: 'connection_refused' });
        expect(new Set(requests.map(request => request.headers['webhook-id'])).size).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([410, 413])('treats %i as final for a control body', async status => {
        const { engine, record, requests } = setup(() => ({ status, body: '' }));
        expect(await engine.sendControl(record, { type: 'gap', cursor: 'p9' })).toEqual({ status, body: '' });
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(1);
    });

    it('never moves the watermark or the delivery status', async () => {
        const answers: Array<(outcome: WebhookSendOutcome) => void> = [];
        const { engine, record, until } = setup(request =>
            'type' in bodyOf(request) ? { status: 200, body: '' } : new Promise(resolve => answers.push(resolve))
        );
        await engine.sendControl(recordFor({ id: 'sub_2' }), { type: 'gap', cursor: 'p9' });
        expect(engine.size).toBe(0);

        engine.track(ID, 'p0');
        engine.deliver(record, occurrence('evt_1'), 'p1', null);
        await until(2);
        expect(await engine.sendControl(record, { type: 'gap', cursor: 'p9' })).toEqual({ status: 200, body: '' });
        expect(engine.watermark(ID)).toBe('p0');
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: null, lastError: null });
        answers[0]!({ status: 200, body: '' });
        await settle();
        expect(engine.watermark(ID)).toBe('p1');
    });

    it.each(['forget', 'clear'])('stops retrying a control body on %s()', async stop => {
        const { engine, record, requests, until } = setup(() => ({ status: 503, body: '' }));
        const outcome = engine.sendControl(record, { type: 'gap', cursor: 'p9' });
        await until(1);
        await settle();
        if (stop === 'forget') engine.forget(ID);
        else engine.clear();
        expect(await outcome).toEqual({ status: 503, body: '' });
        expect(requests[0]!.signal.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(1);
    });

    it('never sends a control body over 256 KiB', async () => {
        const { engine, record, sender, onerror } = setup();
        const error = { code: -32_024, message: 'Forbidden', data: { blob: 'x'.repeat(262_144) } };
        expect(await engine.sendControl(record, { type: 'terminated', error })).toBeUndefined();
        expect(sender).not.toHaveBeenCalled();
        expect((onerror.mock.calls[0]![0] as Error).message).toContain('262144');
    });
});

describe('forget and clear', () => {
    it('forget() stops the retries, and the last subscription of a url ends its verification', async () => {
        const { engine, record, requests, until } = setup(request =>
            bodyOf(request).type === 'verification' ? echo(request) : { status: 500, body: '' }
        );
        await engine.verify('u', HOOK_URL, SECRET, ID);
        await engine.verify('u', HOOK_URL, SECRET, 'sub_2');
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(2);
        await settle();

        engine.forget(ID);
        expect(engine.watermark(ID)).toBeUndefined();
        expect(engine.status(ID)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(2);
        await engine.verify('u', HOOK_URL, SECRET, 'sub_3');
        expect(requests).toHaveLength(2);

        engine.forget('sub_2');
        engine.forget('sub_3');
        await engine.verify('u', HOOK_URL, SECRET, ID);
        expect(requests).toHaveLength(3);
    });

    it('clear() drops every watermark, status, pending retry and verification, and aborts sends in flight', async () => {
        const answers: Array<(outcome: WebhookSendOutcome) => void> = [];
        const { engine, record, requests, until } = setup(request =>
            bodyOf(request).type === 'verification' ? echo(request) : new Promise(resolve => answers.push(resolve))
        );
        await engine.verify('u', HOOK_URL, SECRET, ID);
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(2);
        expect(requests[1]!.signal.aborted).toBe(false);

        engine.clear();
        expect(requests[1]!.signal.aborted).toBe(true);
        expect(engine.watermark(ID)).toBeUndefined();
        expect(engine.status(ID)).toBeUndefined();
        expect(engine.size).toBe(0);
        answers[0]!({ status: 500, body: '' });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(2);
        expect(engine.status(ID)).toBeUndefined();

        await engine.verify('u', HOOK_URL, SECRET, ID);
        expect(requests).toHaveLength(3);
    });

    it('clear() forgets failed verifications and the host limits', async () => {
        let refuse = true;
        const { engine, requests } = setup(request => (refuse ? { error: 'timeout' } : echo(request)));
        await expect(engine.verify('u1', HOOK_URL, SECRET, 'sub_1')).rejects.toMatchObject({ data: { reason: 'timeout' } });
        for (let n = 2; n <= 10; n++)
            await expect(engine.verify(`u${n}`, HOOK_URL, SECRET, `sub_${n}`)).rejects.toBeInstanceOf(EventsError);
        await expect(engine.verify('u11', HOOK_URL, SECRET, 'sub_11')).rejects.toMatchObject({ code: -32_025 });
        await expect(engine.verify('u1', HOOK_URL, SECRET, 'sub_1')).rejects.toMatchObject({ code: -32_027 });
        expect(requests).toHaveLength(10);

        engine.clear();
        refuse = false;
        await engine.verify('u1', HOOK_URL, SECRET, 'sub_1');
        await engine.verify('u11', HOOK_URL, SECRET, 'sub_11');
        expect(requests).toHaveLength(12);
    });

    it('track() starts the watermark again for a subscription it already tracks', async () => {
        const { engine, record, until } = setup();
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        await until(1);
        await settle();
        expect(engine.watermark(ID)).toBe('p1');
        engine.track(ID, 'c7');
        expect(engine.watermark(ID)).toBe('c7');
        expect(engine.size).toBe(1);
    });
});
