import type { WebhookSubscriptionRecord, WebhookSubscriptionStore } from './types';

/**
 * The default {@linkcode WebhookSubscriptionStore}: webhook subscriptions in
 * this process's memory. They are lost on restart, and replicas do not share
 * them; give replicas one shared store instead.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class InMemoryWebhookSubscriptionStore implements WebhookSubscriptionStore {
    readonly #records = new Map<string, WebhookSubscriptionRecord>();

    get(id: string): Promise<WebhookSubscriptionRecord | undefined> {
        return Promise.resolve(this.#records.get(id));
    }

    put(record: WebhookSubscriptionRecord): Promise<void> {
        this.#records.set(record.id, record);
        return Promise.resolve();
    }

    delete(id: string): Promise<boolean> {
        return Promise.resolve(this.#records.delete(id));
    }

    async *listByName(name: string): AsyncIterable<WebhookSubscriptionRecord> {
        for (const record of this.#records.values()) if (record.name === name) yield record;
    }
}
