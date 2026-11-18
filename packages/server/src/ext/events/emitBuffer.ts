import type { EventOccurrence } from '@modelcontextprotocol/core/ext/events';

// One emitted event; `target` is the subscriptionId of a targeted emit.
export interface BufferedEvent {
    readonly occurrence: EventOccurrence;
    readonly target?: string;
}

export interface BufferRead {
    events: EventOccurrence[];
    cursor: string;
    truncated: boolean;
    hasMore: boolean;
}

interface Entry {
    readonly at: number;
    readonly event: BufferedEvent;
}

// The entries of one event type hold the sequence numbers `evicted + 1` through `last`.
interface Ring {
    readonly entries: Entry[];
    last: number;
    evicted: number;
}

const CURSOR = /^e([0-9a-f]{8})\.(0|[1-9]\d*)$/;

function newEpoch(): string {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16).padStart(8, '0');
}

// Per-type in-memory ring of emitted events; cursors `e<epoch>.<sequence>` are valid only for this instance's epoch.
export class EmitBuffer {
    readonly #maxAgeMs: number;
    readonly #maxEvents: number;
    readonly #now: () => number;
    readonly #rings = new Map<string, Ring>();
    // Drawn at first use: Cloudflare Workers refuse random values at module scope, where an extension is built.
    #epoch: string | undefined;

    constructor(limits: { maxAgeMs: number; maxEvents: number }, now: () => number = () => Date.now()) {
        this.#maxAgeMs = limits.maxAgeMs;
        this.#maxEvents = limits.maxEvents;
        this.#now = now;
    }

    // Returns the position just before the appended event (the previous head).
    append(name: string, event: BufferedEvent): string {
        let ring = this.#rings.get(name);
        if (ring === undefined) {
            ring = { entries: [], last: 0, evicted: 0 };
            this.#rings.set(name, ring);
        }
        const previous = this.#format(ring.last);
        ring.last += 1;
        ring.entries.push({ at: this.#now(), event });
        this.#evict(ring);
        return previous;
    }

    head(name: string): string {
        return this.#format(this.#rings.get(name)?.last ?? 0);
    }

    // A cursor this buffer cannot serve from reads as a gap: no events, `truncated`, and the oldest servable position.
    read(
        name: string,
        cursor: string | null,
        options: { maxEvents: number; maxAgeMs?: number; select(event: BufferedEvent): EventOccurrence | undefined }
    ): BufferRead {
        const ring = this.#rings.get(name) ?? { entries: [], last: 0, evicted: 0 };
        this.#evict(ring);
        if (cursor === null) return { events: [], cursor: this.#format(ring.last), truncated: false, hasMore: false };
        const parsed = this.#parse(cursor);
        const valid = parsed !== undefined && parsed >= ring.evicted && parsed <= ring.last;
        let index = valid ? parsed - ring.evicted : 0;
        let skipped = false;
        if (options.maxAgeMs !== undefined) {
            const floor = this.#now() - options.maxAgeMs;
            while (index < ring.entries.length && ring.entries[index]!.at < floor) {
                index += 1;
                skipped = true;
            }
        }
        if (!valid) {
            const position = ring.evicted + index;
            return { events: [], cursor: this.#format(position), truncated: true, hasMore: position < ring.last };
        }
        const events: EventOccurrence[] = [];
        while (index < ring.entries.length && events.length < options.maxEvents) {
            const selected = options.select(ring.entries[index]!.event);
            index += 1;
            if (selected !== undefined) events.push(selected);
        }
        const position = ring.evicted + index;
        return { events, cursor: this.#format(position), truncated: skipped, hasMore: position < ring.last };
    }

    // Retained events per event type.
    sizes(): Record<string, number> {
        const sizes: Record<string, number> = {};
        for (const [name, ring] of this.#rings) {
            this.#evict(ring);
            sizes[name] = ring.entries.length;
        }
        return sizes;
    }

    // Drops the events of one type but keeps its sequence, so a cursor from before its head reads as a gap.
    drop(name: string): void {
        const ring = this.#rings.get(name);
        if (ring === undefined) return;
        ring.entries.length = 0;
        ring.evicted = ring.last;
    }

    // Drops every event and starts a new epoch, as a process restart would.
    clear(): void {
        this.#rings.clear();
        this.#epoch = undefined;
    }

    #evict(ring: Ring): void {
        const floor = this.#now() - this.#maxAgeMs;
        let drop = 0;
        while (drop < ring.entries.length && (ring.entries.length - drop > this.#maxEvents || ring.entries[drop]!.at < floor)) drop += 1;
        if (drop === 0) return;
        ring.entries.splice(0, drop);
        ring.evicted += drop;
    }

    #currentEpoch(): string {
        this.#epoch ??= newEpoch();
        return this.#epoch;
    }

    #format(sequence: number): string {
        return `e${this.#currentEpoch()}.${sequence}`;
    }

    #parse(cursor: string): number | undefined {
        const match = CURSOR.exec(cursor);
        if (match === null || match[1] !== this.#currentEpoch()) return undefined;
        const sequence = Number(match[2]);
        return Number.isSafeInteger(sequence) ? sequence : undefined;
    }
}
