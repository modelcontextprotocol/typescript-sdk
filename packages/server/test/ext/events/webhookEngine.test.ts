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
    it.each(failures)('fails verification with %o as %s', async (outcome, reason) => {
        const { engine, requests } = setup(() => outcome);
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toMatchObject({ code: -32_027, data: { reason } });
        await expect(engine.verify('u', HOOK_URL, SECRET, ID)).rejects.toBeInstanceOf(EventsError);
        expect(requests).toHaveLength(2);
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
            expect(bodyOf(request)).toEqual({ ...occurrence('evt_1'), cursor: 'p0' });
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

    it('holds the watermark behind an unacknowledged event', async () => {
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
        expect(requests.map(request => bodyOf(request).cursor)).toEqual(['p0', 'p0', 'p0']);

        failFirst = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(4);
        await settle();
        expect(engine.watermark(ID)).toBe('p3');

        engine.deliver(record, occurrence('evt_4'), 'p4', null);
        await until(5);
        expect(bodyOf(requests[4]!).cursor).toBe('p3');
    });

    it('tracks an unknown subscription from the seed, so every POST carries a cursor (F3a)', async () => {
        const { engine, record, requests, until } = setup();
        expect(engine.watermark(ID)).toBeUndefined();
        expect(engine.status(ID)).toBeUndefined();
        engine.deliver(record, occurrence('evt_1'), 'p1', 'p0');
        engine.deliver(record, occurrence('evt_2'), 'p2', 'p1');
        await until(2);
        await settle();
        expect(requests.map(request => bodyOf(request).cursor)).toEqual(['p0', 'p0']);
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
        engine.track(ID, 'p0');
        for (let n = 1; n <= 100; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(100);
        await settle();
        // 95 of 100 attempts failed: not more than 95 %.
        expect(engine.status(ID)).toMatchObject({ active: true });

        const failedAt = Date.now();
        engine.deliver(record, occurrence('evt_101'), 'p101', null);
        await until(101);
        await settle();
        expect(engine.status(ID)).toEqual({
            active: false,
            lastDeliveryAt: new Date(failedAt).toISOString(),
            lastError: 'http_5xx',
            failedSince: new Date(failedAt).toISOString()
        });

        engine.deliver(record, occurrence('evt_102'), 'p102', null);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(requests).toHaveLength(101);
        expect(engine.watermark(ID)).toBe('p5');

        healthy = true;
        engine.resume(ID);
        await until(101 + 97);
        await settle();
        expect(engine.status(ID)).toEqual({ active: true, lastDeliveryAt: new Date().toISOString(), lastError: null });
        expect(engine.watermark(ID)).toBe('p102');
    });

    it('counts only the attempts of the last 60 minutes', async () => {
        let failing = true;
        const { engine, store, until } = setup(() => (failing ? { status: 503, body: '' } : { status: 200, body: '' }));
        const record = recordFor({ expiresAt: Date.now() + 86_400_000 });
        await store.put(record);
        engine.track(ID, 'p0');
        for (let n = 1; n <= 99; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(99);
        await settle();
        failing = false;
        await vi.advanceTimersByTimeAsync(5000);
        await until(198);
        await settle();
        expect(engine.watermark(ID)).toBe('p99');

        // Counted with the hour before, these would be 199 failures in 298 attempts; alone they are 100 in 100.
        await vi.advanceTimersByTimeAsync(3_600_000);
        failing = true;
        for (let n = 100; n <= 199; n++) engine.deliver(record, occurrence(`evt_${n}`), `p${n}`, null);
        await until(298);
        await settle();
        expect(engine.status(ID)).toMatchObject({ active: false });
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

    it('returns a failed outcome as it is', async () => {
        const { engine, record } = setup(() => ({ error: 'connection_refused' }));
        expect(await engine.sendControl(record, { type: 'gap', cursor: null })).toEqual({ error: 'connection_refused' });
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
