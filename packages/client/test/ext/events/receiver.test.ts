import { ProtocolError } from '@modelcontextprotocol/core-internal';
import { generateWebhookSecret } from '@modelcontextprotocol/core-internal/ext/events';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventsError } from '../../../src/ext/events/index';
import type { WebhookSink } from '../../../src/ext/events/receiver';
import { WebhookReceiver } from '../../../src/ext/events/receiver';
import { occurrence, WEBHOOK_URL, webhookPost } from './scripted';

type MockSink = { [K in keyof WebhookSink]: Mock<WebhookSink[K]> };

function sink(): MockSink {
    return { full: vi.fn(() => false), event: vi.fn(), gap: vi.fn(), terminated: vi.fn() };
}

/** A receiver routing `sub_1` to a fresh sink. */
function bound(): { receiver: WebhookReceiver; secret: string; target: MockSink } {
    const receiver = new WebhookReceiver();
    const secret = generateWebhookSecret();
    const target = sink();
    receiver.bind('sub_1', secret, target);
    return { receiver, secret, target };
}

const now = () => Math.floor(Date.now() / 1000);

async function statusOf(receiver: WebhookReceiver, request: Promise<Request>): Promise<number> {
    const response = await receiver.handle(await request);
    return response.status;
}

// A frozen clock, so a second does not tick over between signing and receiving.
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('WebhookReceiver', () => {
    it('delivers a verified event once', async () => {
        const { receiver, secret, target } = bound();
        const event = { ...occurrence('e1'), cursor: 'c1' };

        const first = await receiver.handle(await webhookPost(event, secret, 'sub_1', { webhookId: 'msg_1' }));
        expect(first.status).toBe(200);
        expect(target.event).toHaveBeenCalledExactlyOnceWith(event);

        // A retry keeps its webhook-id and is signed again with a fresh timestamp.
        const retry = await receiver.handle(await webhookPost(event, secret, 'sub_1', { webhookId: 'msg_1', timestamp: now() + 5 }));
        expect(retry.status).toBe(200);
        expect(target.event).toHaveBeenCalledOnce();
        // The signature is checked before the webhook-id.
        const forged = await receiver.handle(await webhookPost(event, generateWebhookSecret(), 'sub_1', { webhookId: 'msg_1' }));
        expect(forged.status).toBe(401);
    });

    it('remembers the last 1 000 webhook-ids', async () => {
        const { receiver, secret, target } = bound();
        const post = (webhookId: string) => statusOf(receiver, webhookPost(occurrence('e1'), secret, 'sub_1', { webhookId }));

        expect(await post('msg_0')).toBe(200);
        for (let index = 1; index < 1000; index++) await post(`msg_${index}`);
        expect(await post('msg_0')).toBe(200);
        expect(target.event).toHaveBeenCalledTimes(1000);

        await post('msg_1000');
        expect(await post('msg_0')).toBe(200);
        expect(target.event).toHaveBeenCalledTimes(1002);
    });

    it('answers a challenge for a not-yet-bound id and binds it', async () => {
        const receiver = new WebhookReceiver();
        const secret = generateWebhookSecret();
        const target = sink();
        const onBind = vi.fn((id: string) => receiver.bind(id, secret, target));
        const other = vi.fn();
        receiver.registerPending(generateWebhookSecret(), other);
        receiver.registerPending(secret, onBind);

        const answer = await receiver.handle(await webhookPost({ type: 'verification', challenge: 'nonce-1' }, secret, 'sub_x'));
        expect(answer.status).toBe(200);
        expect(answer.headers.get('content-type')).toBe('application/json');
        expect(await answer.json()).toEqual({ challenge: 'nonce-1' });
        expect(onBind).toHaveBeenCalledExactlyOnceWith('sub_x');
        expect(other).not.toHaveBeenCalled();

        const event = await receiver.handle(await webhookPost(occurrence('e1'), secret, 'sub_x'));
        expect(event.status).toBe(200);
        expect(target.event).toHaveBeenCalledOnce();

        // A server that lost its verification (a restart) challenges the bound id again: that id's secret answers it.
        const again = await receiver.handle(await webhookPost({ type: 'verification', challenge: 'nonce-2' }, secret, 'sub_x'));
        expect(await again.json()).toEqual({ challenge: 'nonce-2' });
        expect(onBind).toHaveBeenCalledOnce();
    });

    it('refuses a challenge no pending secret signs, and one for a withdrawn secret', async () => {
        const receiver = new WebhookReceiver();
        const secret = generateWebhookSecret();
        const onBind = vi.fn();
        const withdraw = receiver.registerPending(secret, onBind);

        const unknown = await receiver.handle(
            await webhookPost({ type: 'verification', challenge: 'n' }, generateWebhookSecret(), 'sub_x')
        );
        expect(unknown.status).toBe(401);
        withdraw();
        const withdrawn = await receiver.handle(await webhookPost({ type: 'verification', challenge: 'n' }, secret, 'sub_x'));
        expect(withdrawn.status).toBe(401);
        expect(onBind).not.toHaveBeenCalled();
    });

    it('rejects bad signatures, stale timestamps and unknown ids', async () => {
        const { receiver, secret, target } = bound();
        const status = (request: Promise<Request>) => statusOf(receiver, request);
        const event = occurrence('e1');

        expect(await status(webhookPost(event, generateWebhookSecret(), 'sub_1'))).toBe(401);
        expect(await status(webhookPost(event, secret, 'sub_1', { timestamp: now() - 301 }))).toBe(400);
        expect(await status(webhookPost(event, secret, 'sub_1', { timestamp: now() + 301 }))).toBe(400);
        expect(await status(webhookPost(event, secret, 'sub_unknown'))).toBe(503);
        // Verified, but not routed anywhere yet.
        const pending = generateWebhookSecret();
        receiver.registerPending(pending, () => {});
        expect(await status(webhookPost({ type: 'verification', challenge: 'n' }, pending, 'sub_2'))).toBe(200);
        expect(await status(webhookPost(event, pending, 'sub_2'))).toBe(503);
        for (const omit of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'X-MCP-Subscription-Id']) {
            expect(await status(webhookPost(event, secret, 'sub_1', { omit }))).toBe(400);
        }
        expect(target.event).not.toHaveBeenCalled();

        expect(await status(webhookPost(event, secret, 'sub_1', { timestamp: now() - 300 }))).toBe(200);
        receiver.forget('sub_1', target);
        expect(await status(webhookPost(occurrence('e2'), secret, 'sub_1'))).toBe(503);
        expect(target.event).toHaveBeenCalledOnce();
    });

    it('forgets an id only for the sink it routes to', async () => {
        const { receiver, secret, target } = bound();
        // A subscription that ended after another one took over the same id.
        receiver.forget('sub_1', sink());
        expect(await statusOf(receiver, webhookPost(occurrence('e1'), secret, 'sub_1'))).toBe(200);
        expect(target.event).toHaveBeenCalledOnce();

        receiver.forget('sub_1', target);
        expect(await statusOf(receiver, webhookPost(occurrence('e2'), secret, 'sub_1'))).toBe(503);
    });

    it('rejects non-POST and oversized bodies', async () => {
        const { receiver, secret, target } = bound();
        const get = await receiver.handle(new Request(WEBHOOK_URL, { method: 'GET' }));
        expect(get.status).toBe(405);
        expect(get.headers.get('allow')).toBe('POST');

        // A body of exactly the cap is accepted; one byte more is refused.
        const sized = (bytes: number) => {
            const base = JSON.stringify({ ...occurrence('e1'), data: { pad: '' } }).length;
            return { ...occurrence('e1'), data: { pad: 'x'.repeat(bytes - base) } };
        };
        expect(await statusOf(receiver, webhookPost(sized(262_145), secret, 'sub_1'))).toBe(413);
        expect(target.event).not.toHaveBeenCalled();
        expect(await statusOf(receiver, webhookPost(sized(262_144), secret, 'sub_1'))).toBe(200);
        expect(target.event).toHaveBeenCalledOnce();
    });

    it('answers 503 to an event for a full subscription without remembering its webhook-id, and takes control bodies', async () => {
        const { receiver, secret, target } = bound();
        target.full.mockReturnValue(true);
        const event = { ...occurrence('e1'), cursor: 'c1' };
        expect(await statusOf(receiver, webhookPost(event, secret, 'sub_1', { webhookId: 'msg_1' }))).toBe(503);
        expect(await statusOf(receiver, webhookPost({ type: 'gap', cursor: 'c0' }, secret, 'sub_1'))).toBe(200);
        expect(target.event).not.toHaveBeenCalled();
        expect(target.gap).toHaveBeenCalledOnce();

        target.full.mockReturnValue(false);
        expect(await statusOf(receiver, webhookPost(event, secret, 'sub_1', { webhookId: 'msg_1' }))).toBe(200);
        expect(target.event).toHaveBeenCalledExactlyOnceWith(event);
    });

    it('routes gap and terminated bodies, and refuses malformed ones', async () => {
        const { receiver, secret, target } = bound();
        const status = (body: unknown) => statusOf(receiver, webhookPost(body, secret, 'sub_1'));

        expect(await status({ type: 'gap', cursor: 'c9' })).toBe(200);
        expect(await status({ type: 'gap' })).toBe(200);
        expect(target.gap.mock.calls).toEqual([['c9'], [null]]);

        expect(
            await status({ type: 'terminated', error: { code: -32_024, message: 'Forbidden', data: { reason: 'Access revoked' } } })
        ).toBe(200);
        expect(await status({ type: 'terminated', error: { code: -32_603, message: 'Internal error' } })).toBe(200);
        const [forbidden, internal] = target.terminated.mock.calls.map(([error]) => error);
        expect(forbidden).toBeInstanceOf(EventsError);
        expect(forbidden).toMatchObject({ kind: 'forbidden', data: { reason: 'Access revoked' } });
        expect(internal).toBeInstanceOf(ProtocolError);
        expect(internal).not.toBeInstanceOf(EventsError);

        for (const malformed of ['not json', [], { name: 'tick' }, { type: 'unknown' }, { type: 'terminated' }]) {
            expect(await status(malformed)).toBe(400);
        }
        expect(target.event).not.toHaveBeenCalled();
        expect(target.gap).toHaveBeenCalledTimes(2);
        expect(target.terminated).toHaveBeenCalledTimes(2);
    });
});
