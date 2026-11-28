import type { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { canonicalJson } from '@modelcontextprotocol/core-internal/ext/events';

// setTimeout fires at once for longer delays; a longer lease re-arms when the timer fires early.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const encoder = new TextEncoder();

export interface Lease {
    readonly subscriptionId: string;
    readonly name: string;
    readonly principal: string | null;
    readonly args: Record<string, unknown>;
    terminated?: EventsError;
}

// One lease per (principal or null, event name, canonical arguments), as SEP-3415 Appendix A keys poll subscriptions: the base64 SHA-256 of their canonical JSON, so a key's size does not grow with the arguments.
export async function leaseKey(principal: string | null, name: string, args: Record<string, unknown>): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson([principal, name, args])));
    let binary = '';
    for (const byte of new Uint8Array(digest)) binary += String.fromCodePoint(byte);
    return btoa(binary);
}

interface Slot<L> {
    readonly lease: L;
    expiresAt: number;
    timer?: ReturnType<typeof setTimeout>;
}

// Poll leases: `touch` creates or renews one, and a lease expires `ttlMs` after its last touch, when the table is next read or counted, or earlier by its timer (a runtime such as Cloudflare Workers drops a request's timers once it is answered).
export class LeaseTable<L extends Lease = Lease> {
    readonly #slots = new Map<string, Slot<L>>();
    readonly #ttlMs: number;
    readonly #onExpire: (lease: L) => void;
    readonly #now: () => number;

    constructor(ttlMs: number, onExpire: (lease: L) => void, now: () => number = () => Date.now()) {
        this.#ttlMs = ttlMs;
        this.#onExpire = onExpire;
        this.#now = now;
    }

    get size(): number {
        this.#expireDue();
        return this.#slots.size;
    }

    get(key: string): L | undefined {
        this.#expireIfDue(key);
        return this.#slots.get(key)?.lease;
    }

    // The leases `principal` holds.
    countOf(principal: string | null): number {
        this.#expireDue();
        let count = 0;
        for (const { lease } of this.#slots.values()) if (lease.principal === principal) count += 1;
        return count;
    }

    touch(key: string, create: () => L): { lease: L; created: boolean } {
        this.#expireIfDue(key);
        const existing = this.#slots.get(key);
        if (existing !== undefined) {
            existing.expiresAt = this.#now() + this.#ttlMs;
            return { lease: existing.lease, created: false };
        }
        const slot: Slot<L> = { lease: create(), expiresAt: this.#now() + this.#ttlMs };
        this.#slots.set(key, slot);
        this.#arm(key, slot);
        return { lease: slot.lease, created: true };
    }

    forEach(name: string, fn: (lease: L) => void): void {
        this.#expireDue();
        for (const { lease } of this.#slots.values()) {
            if (lease.name === name) fn(lease);
        }
    }

    delete(key: string): void {
        const slot = this.#slots.get(key);
        if (slot === undefined) return;
        clearTimeout(slot.timer);
        this.#slots.delete(key);
    }

    // Drops every lease without expiring it, as a process restart would.
    clear(): void {
        for (const slot of this.#slots.values()) clearTimeout(slot.timer);
        this.#slots.clear();
    }

    #arm(key: string, slot: Slot<L>): void {
        const delay = Math.min(Math.max(slot.expiresAt - this.#now(), 0), MAX_TIMER_DELAY_MS);
        slot.timer = setTimeout(() => this.#fire(key, slot), delay);
        (slot.timer as { unref?: () => void }).unref?.();
    }

    // One timer per lease: a touch moves `expiresAt`, and the timer re-arms until it is reached.
    #fire(key: string, slot: Slot<L>): void {
        if (this.#slots.get(key) !== slot) return;
        if (slot.expiresAt > this.#now()) {
            this.#arm(key, slot);
            return;
        }
        this.#expire(key, slot);
    }

    #expireIfDue(key: string): void {
        const slot = this.#slots.get(key);
        if (slot !== undefined && slot.expiresAt <= this.#now()) this.#expire(key, slot);
    }

    // Every lease past its `expiresAt`, found before any expires, so an `onExpire` that reads the table meanwhile changes nothing here.
    #expireDue(): void {
        const now = this.#now();
        const due = [...this.#slots].filter(([, slot]) => slot.expiresAt <= now);
        for (const [key, slot] of due) this.#expire(key, slot);
    }

    // Once per lease: an `onExpire` that already expired it, by reading the table, leaves nothing to do.
    #expire(key: string, slot: Slot<L>): void {
        if (this.#slots.get(key) !== slot) return;
        clearTimeout(slot.timer);
        this.#slots.delete(key);
        this.#onExpire(slot.lease);
    }
}
