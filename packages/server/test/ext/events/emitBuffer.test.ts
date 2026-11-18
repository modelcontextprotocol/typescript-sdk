import type { EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import { describe, expect, it } from 'vitest';

import type { BufferedEvent } from '../../../src/ext/events/emitBuffer';
import { EmitBuffer } from '../../../src/ext/events/emitBuffer';

function occurrence(n: number): EventOccurrence {
    return { eventId: `evt_${n}`, name: 'i', timestamp: '2026-01-01T00:00:00.000Z', data: { n } };
}

const all = (event: BufferedEvent): EventOccurrence => event.occurrence;
const ids = (events: EventOccurrence[]): string[] => events.map(event => event.eventId);

function filled(count: number, limits = { maxAgeMs: 60_000, maxEvents: 100 }, now?: () => number): EmitBuffer {
    const buffer = new EmitBuffer(limits, now);
    for (let n = 1; n <= count; n++) buffer.append('i', { occurrence: occurrence(n) });
    return buffer;
}

describe('EmitBuffer', () => {
    it('appends and reads events in order', () => {
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 100 });
        const start = buffer.head('i');
        for (let n = 1; n <= 3; n++) buffer.append('i', { occurrence: occurrence(n) });
        const read = buffer.read('i', start, { maxEvents: 10, select: all });
        expect(read).toEqual({
            events: [occurrence(1), occurrence(2), occurrence(3)],
            cursor: buffer.head('i'),
            truncated: false,
            hasMore: false
        });
        expect(buffer.read('i', read.cursor, { maxEvents: 10, select: all })).toEqual({
            events: [],
            cursor: read.cursor,
            truncated: false,
            hasMore: false
        });
    });

    it('answers a null cursor with the head and no events', () => {
        const buffer = filled(2);
        expect(buffer.read('i', null, { maxEvents: 10, select: all })).toEqual({
            events: [],
            cursor: buffer.head('i'),
            truncated: false,
            hasMore: false
        });
    });

    it('returns the previous head from append', () => {
        const buffer = filled(1);
        const before = buffer.head('i');
        expect(buffer.append('i', { occurrence: occurrence(2) })).toBe(before);
        expect(buffer.head('i')).not.toBe(before);
        expect(ids(buffer.read('i', before, { maxEvents: 10, select: all }).events)).toEqual(['evt_2']);
    });

    it('keeps one sequence per event type', () => {
        const buffer = filled(2);
        const other = buffer.head('j');
        buffer.append('j', { occurrence: { ...occurrence(9), name: 'j' } });
        expect(ids(buffer.read('j', other, { maxEvents: 10, select: all }).events)).toEqual(['evt_9']);
        expect(buffer.read('i', buffer.head('i'), { maxEvents: 10, select: all }).events).toEqual([]);
    });

    it('pages with maxEvents and resumes at the next event', () => {
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 100 });
        const start = buffer.head('i');
        for (let n = 1; n <= 3; n++) buffer.append('i', { occurrence: occurrence(n) });
        const first = buffer.read('i', start, { maxEvents: 1, select: all });
        expect(first).toMatchObject({ truncated: false, hasMore: true });
        expect(ids(first.events)).toEqual(['evt_1']);
        const second = buffer.read('i', first.cursor, { maxEvents: 1, select: all });
        expect(ids(second.events)).toEqual(['evt_2']);
        expect(second.hasMore).toBe(true);
        const third = buffer.read('i', second.cursor, { maxEvents: 1, select: all });
        expect(ids(third.events)).toEqual(['evt_3']);
        expect(third).toMatchObject({ cursor: buffer.head('i'), hasMore: false });
    });

    it('skips the events select drops and still advances past them', () => {
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 100 });
        const start = buffer.head('i');
        for (let n = 1; n <= 4; n++) buffer.append('i', { occurrence: occurrence(n), ...(n === 2 ? { target: 'sub-a' } : {}) });
        const read = buffer.read('i', start, {
            maxEvents: 10,
            select: event => (event.target === undefined ? event.occurrence : undefined)
        });
        expect(ids(read.events)).toEqual(['evt_1', 'evt_3', 'evt_4']);
        expect(read.cursor).toBe(buffer.head('i'));
    });

    it('evicts beyond the count bound', () => {
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 2 });
        const start = buffer.head('i');
        const positions = [1, 2, 3].map(n => buffer.append('i', { occurrence: occurrence(n) }));
        const gap = buffer.read('i', start, { maxEvents: 10, select: all });
        expect(gap).toEqual({ events: [], cursor: positions[1], truncated: true, hasMore: true });
        expect(ids(buffer.read('i', gap.cursor, { maxEvents: 10, select: all }).events)).toEqual(['evt_2', 'evt_3']);
    });

    it('evicts beyond the age bound', () => {
        let now = 0;
        const buffer = new EmitBuffer({ maxAgeMs: 1000, maxEvents: 100 }, () => now);
        const start = buffer.head('i');
        buffer.append('i', { occurrence: occurrence(1) });
        now = 500;
        const second = buffer.append('i', { occurrence: occurrence(2) });
        now = 1001;
        const gap = buffer.read('i', start, { maxEvents: 10, select: all });
        expect(gap).toEqual({ events: [], cursor: second, truncated: true, hasMore: true });
        expect(ids(buffer.read('i', gap.cursor, { maxEvents: 10, select: all }).events)).toEqual(['evt_2']);
        now = 1501;
        expect(buffer.read('i', gap.cursor, { maxEvents: 10, select: all })).toEqual({
            events: [],
            cursor: buffer.head('i'),
            truncated: true,
            hasMore: false
        });
    });

    it.each([
        ['older than the oldest retained event', (buffer: EmitBuffer) => buffer.head('i')],
        ['from another EmitBuffer', () => filled(1).head('i')],
        ['garbage', () => 'garbage'],
        ['ahead of the head', (buffer: EmitBuffer) => buffer.head('i').replace(/\.\d+$/, '.99')]
    ])('reads a cursor %s as a gap from the oldest retained position (Review Focus 5)', (_label, cursorOf) => {
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 2 });
        const cursor = cursorOf(buffer);
        const positions = [1, 2, 3].map(n => buffer.append('i', { occurrence: occurrence(n) }));
        const oldestRetained = positions[1];
        expect(buffer.read('i', cursor, { maxEvents: 10, select: all })).toEqual({
            events: [],
            cursor: oldestRetained,
            truncated: true,
            hasMore: true
        });
    });

    it('starts replay at the maxAgeMs floor and flags the skip', () => {
        let now = 0;
        const buffer = new EmitBuffer({ maxAgeMs: 60_000, maxEvents: 100 }, () => now);
        const start = buffer.head('i');
        buffer.append('i', { occurrence: occurrence(1) });
        now = 10_000;
        buffer.append('i', { occurrence: occurrence(2) });
        now = 12_000;
        const read = buffer.read('i', start, { maxEvents: 10, maxAgeMs: 5000, select: all });
        expect(ids(read.events)).toEqual(['evt_2']);
        expect(read).toMatchObject({ cursor: buffer.head('i'), truncated: true, hasMore: false });
        expect(buffer.read('i', start, { maxEvents: 10, maxAgeMs: 20_000, select: all }).truncated).toBe(false);
    });

    it('clear() drops every event and starts a new epoch', () => {
        const buffer = filled(2);
        const before = buffer.head('i');
        buffer.clear();
        expect(buffer.sizes()).toEqual({});
        const after = buffer.head('i');
        expect(after).not.toBe(before);
        expect(buffer.read('i', before, { maxEvents: 10, select: all })).toEqual({
            events: [],
            cursor: after,
            truncated: true,
            hasMore: false
        });
    });

    it('reports how many events each type holds', () => {
        const buffer = filled(3, { maxAgeMs: 60_000, maxEvents: 2 });
        buffer.append('j', { occurrence: { ...occurrence(1), name: 'j' } });
        expect(buffer.sizes()).toEqual({ i: 2, j: 1 });
    });

    it('formats cursors as e<epoch>.<sequence>', () => {
        expect(filled(2).head('i')).toMatch(/^e[0-9a-f]{8}\.2$/);
    });
});
