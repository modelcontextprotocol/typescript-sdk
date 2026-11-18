import { describe, expect, it } from 'vitest';

import type { WebhookSubscriptionRecord } from '../../../src/ext/events/index';
import { InMemoryWebhookSubscriptionStore } from '../../../src/ext/events/index';

function recordFor(id: string, name = 'e'): WebhookSubscriptionRecord {
    return {
        id,
        principal: 'u1',
        name,
        arguments: { a: 1 },
        url: 'https://hooks.example.com/mcp',
        secret: 'whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0',
        expiresAt: 2_000_000_000_000,
        createdAt: 1_900_000_000_000
    };
}

async function listed(store: InMemoryWebhookSubscriptionStore, name: string): Promise<string[]> {
    const ids: string[] = [];
    for await (const record of store.listByName(name)) ids.push(record.id);
    return ids;
}

describe('InMemoryWebhookSubscriptionStore', () => {
    it('round-trips put, get and delete', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        const record = recordFor('sub_1');
        await store.put(record);
        expect(await store.get('sub_1')).toEqual(record);

        const refreshed = { ...record, expiresAt: record.expiresAt + 1 };
        await store.put(refreshed);
        expect(await store.get('sub_1')).toEqual(refreshed);

        expect(await store.delete('sub_1')).toBe(true);
        expect(await store.get('sub_1')).toBeUndefined();
    });

    it('lists only the records of one event name', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        await store.put(recordFor('sub_1', 'e'));
        await store.put(recordFor('sub_2', 'other'));
        await store.put(recordFor('sub_3', 'e'));
        expect(await listed(store, 'e')).toEqual(['sub_1', 'sub_3']);
        expect(await listed(store, 'other')).toEqual(['sub_2']);
        expect(await listed(store, 'missing')).toEqual([]);
    });

    it('answers false when deleting an unknown id', async () => {
        const store = new InMemoryWebhookSubscriptionStore();
        expect(await store.delete('sub_missing')).toBe(false);
        await store.put(recordFor('sub_1'));
        expect(await store.delete('sub_1')).toBe(true);
        expect(await store.delete('sub_1')).toBe(false);
    });
});
