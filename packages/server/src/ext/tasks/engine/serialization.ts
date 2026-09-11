/*
 * Undefined-safe JSON serialization envelope for journaled step results.
 *
 * Adapted from avenceslau/durability, pinned at commit 78cb099 (v2.1.0):
 * `packages/durability/src/index.ts` — `storedValueSchema` and the
 * `serialize`/`deserialize` pair. Local adaptation: non-JSON-serializable
 * values are wrapped in {@link ResultSerializationError} here at the envelope
 * (upstream wrapped at the call site).
 * https://github.com/avenceslau/durability
 */

import { z } from 'zod';

import { ResultSerializationError } from './errors';

/**
 * The stored envelope: a plain JSON value, or an explicit `undefined` marker.
 * `z.json()` guarantees the `value` branch holds only JSON-representable data
 * (no functions, bigints, NaN/Infinity, or `undefined` — including nested
 * `undefined` property values, which are rejected rather than silently
 * dropped).
 */
export const storedValueSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('value'), value: z.json() }),
    z.object({ kind: z.literal('undefined') })
]);

export type StoredValue = z.output<typeof storedValueSchema>;

/**
 * Serializes a step result into the undefined-safe envelope.
 *
 * @param value The value to persist. `undefined` round-trips faithfully.
 * @param entity Label used in the {@link ResultSerializationError} message,
 *   e.g. `step "fetch-data"`.
 * @throws ResultSerializationError when the value is not JSON-serializable.
 */
export const serializeValue = (value: unknown, entity = 'value'): string => {
    try {
        return JSON.stringify(value === undefined ? { kind: 'undefined' } : { kind: 'value', value: z.json().parse(value) });
    } catch (error) {
        throw new ResultSerializationError(entity, error);
    }
};

/**
 * Deserializes an envelope produced by {@link serializeValue}.
 *
 * @throws ZodError (via `storedValueSchema.parse`) when the stored text is not
 *   a valid envelope — a corrupt journal row is a programming error, not user
 *   input.
 */
export const deserializeValue = (text: string): unknown => {
    const parsed: unknown = JSON.parse(text);
    const stored = storedValueSchema.parse(parsed);
    return stored.kind === 'undefined' ? undefined : stored.value;
};
