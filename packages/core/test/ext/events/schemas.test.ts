import { describe, expect, it } from 'vitest';

import {
    EventDescriptorSchema,
    eventsCapabilityOf,
    PollEventsRequestParamsSchema,
    PollEventsResultSchema,
    SubscribeEventsRequestParamsSchema,
    WebhookControlBodySchema
} from '../../../src/ext/events/index';

describe('Events wire schemas', () => {
    it('parses the SEP poll result and keeps unknown keys', () => {
        const parsed = PollEventsResultSchema.parse({
            resultType: 'complete',
            events: [{ eventId: 'evt_001', name: 'email.received', timestamp: '2026-02-19T15:30:00Z', data: { messageId: 'msg_xyz' } }],
            cursor: 'historyId_99842',
            truncated: false,
            hasMore: false,
            nextPollMs: 30000,
            future: 1
        });
        expect(parsed.events[0]?.eventId).toBe('evt_001');
        expect((parsed as Record<string, unknown>).future).toBe(1);
    });

    it('treats an absent cursor like null', () => {
        expect(PollEventsRequestParamsSchema.parse({ name: 'x' }).cursor).toBeUndefined();
        expect(PollEventsRequestParamsSchema.parse({ name: 'x', cursor: null }).cursor).toBeNull();
    });

    it('rejects a descriptor with no delivery mode', () => {
        expect(EventDescriptorSchema.safeParse({ name: 'x', delivery: [], inputSchema: {}, payloadSchema: {} }).success).toBe(false);
    });

    it('accepts ttlMs: null and only webhook delivery on subscribe', () => {
        const base = { name: 'x', delivery: { mode: 'webhook', url: 'https://h.example/hook', secret: 'whsec_AAAA' } };
        expect(SubscribeEventsRequestParamsSchema.parse({ ...base, ttlMs: null }).ttlMs).toBeNull();
        expect(SubscribeEventsRequestParamsSchema.safeParse({ ...base, delivery: { ...base.delivery, mode: 'poll' } }).success).toBe(false);
    });

    it('discriminates control bodies and refuses an occurrence as one', () => {
        expect(WebhookControlBodySchema.parse({ type: 'gap', cursor: 'c2' }).type).toBe('gap');
        expect(WebhookControlBodySchema.parse({ type: 'verification', challenge: 'n' }).type).toBe('verification');
        expect(WebhookControlBodySchema.safeParse({ eventId: 'e', name: 'x', timestamp: 't', data: {} }).success).toBe(false);
    });

    it('reads the capability', () => {
        expect(eventsCapabilityOf({ extensions: { 'io.modelcontextprotocol/events': {} } })).toEqual({});
        expect(eventsCapabilityOf({ extensions: { 'io.modelcontextprotocol/events': { listChanged: true } } })).toEqual({
            listChanged: true
        });
        expect(eventsCapabilityOf({ extensions: { 'io.modelcontextprotocol/events': { listChanged: 'yes' } } })).toBeUndefined();
        expect(eventsCapabilityOf({})).toBeUndefined();
    });
});
