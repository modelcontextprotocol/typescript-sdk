import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/core-internal';
import { standardSchemaToJsonSchema, validateStandardSchema } from '@modelcontextprotocol/core-internal';
import { canonicalJson, EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { EventDefinition, EventHandle } from './types';

export type AnyEventDefinition = EventDefinition<StandardSchemaWithJSON, StandardSchemaWithJSON>;

export type EventChanges = Parameters<EventHandle['update']>[0];

// The fields update() changes; anything else on the object it is given is ignored.
const UPDATABLE = ['description', 'inputSchema', 'payloadSchema', '_meta'] as const;

export interface RegisteredEvent {
    readonly name: string;
    readonly kind: 'check' | 'emitOnly';
    readonly definition: AnyEventDefinition;
    readonly inputJson: Record<string, unknown>;
    readonly payloadJson: Record<string, unknown>;
    modes(webhookEnabled: boolean): DeliveryMode[];
    parseArguments(args: unknown): Promise<Record<string, unknown>>;
    parsePayload(data: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }>;
}

// Poll and push unless turned off; webhook only when the server sends webhooks and it is not turned off.
export function deliveryModes(delivery: AnyEventDefinition['delivery'], webhookEnabled: boolean): DeliveryMode[] {
    const modes: DeliveryMode[] = [];
    if (delivery?.poll !== false) modes.push('poll');
    if (delivery?.push !== false) modes.push('push');
    if (webhookEnabled && delivery?.webhook !== false) modes.push('webhook');
    return modes;
}

// The schema that differs between two registrations of one name, by their generated JSON Schemas.
export function changedSchema(previous: RegisteredEvent, next: RegisteredEvent): 'inputSchema' | 'payloadSchema' | undefined {
    if (canonicalJson(previous.inputJson) !== canonicalJson(next.inputJson)) return 'inputSchema';
    if (canonicalJson(previous.payloadJson) !== canonicalJson(next.payloadJson)) return 'payloadSchema';
    return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every event's `data` is an object (SEP-3415), so a payloadSchema whose JSON Schema root is anything else is refused.
function payloadJsonOf(name: string, payloadSchema: AnyEventDefinition['payloadSchema']): Record<string, unknown> {
    const json = standardSchemaToJsonSchema(payloadSchema, 'output');
    if (json.type !== 'object') {
        throw new TypeError(
            `event '${name}': payloadSchema must describe an object (its JSON Schema has type ${JSON.stringify(json.type) ?? 'none'})`
        );
    }
    return json;
}

function createEntry(name: string, definition: AnyEventDefinition): RegisteredEvent {
    const { inputSchema, payloadSchema } = definition;
    const entry: RegisteredEvent = {
        name,
        kind: definition.emitOnly === true ? 'emitOnly' : 'check',
        definition,
        inputJson: inputSchema === undefined ? { type: 'object' } : standardSchemaToJsonSchema(inputSchema, 'input'),
        payloadJson: payloadJsonOf(name, payloadSchema),
        modes: webhookEnabled => deliveryModes(definition.delivery, webhookEnabled),
        parseArguments: async args => {
            const value = args ?? {};
            if (inputSchema === undefined) {
                if (isObject(value)) return value;
                throw new EventsError('invalidParams', `Invalid arguments for event ${name}: expected an object`);
            }
            const parsed = await validateStandardSchema(inputSchema, value);
            if (!parsed.success) throw new EventsError('invalidParams', `Invalid arguments for event ${name}: ${parsed.error}`);
            return parsed.data as Record<string, unknown>;
        },
        parsePayload: async data => {
            const parsed = await validateStandardSchema(payloadSchema, data);
            return parsed.success ? { ok: true, data: parsed.data as Record<string, unknown> } : { ok: false, error: parsed.error };
        }
    };
    return Object.freeze(entry);
}

export class EventRegistry {
    readonly #entries = new Map<string, RegisteredEvent>();

    // Adds an event type, or replaces one whose schemas differ; the same schemas again is a TypeError.
    register(name: string, definition: AnyEventDefinition): RegisteredEvent {
        const entry = createEntry(name, definition);
        const previous = this.#entries.get(name);
        if (previous !== undefined && changedSchema(previous, entry) === undefined) {
            throw new TypeError(`event '${name}' is already registered`);
        }
        this.#entries.set(name, entry);
        return entry;
    }

    // Rebuilds a registered event type with the defined updatable fields of `changes` replaced.
    update(entry: RegisteredEvent, changes: EventChanges): RegisteredEvent {
        const defined = Object.fromEntries(UPDATABLE.filter(key => changes[key] !== undefined).map(key => [key, changes[key]]));
        const next = createEntry(entry.name, { ...entry.definition, ...defined });
        this.#entries.set(entry.name, next);
        return next;
    }

    get(name: string): RegisteredEvent | undefined {
        return this.#entries.get(name);
    }

    require(name: string): RegisteredEvent {
        const entry = this.#entries.get(name);
        if (entry === undefined) throw new EventsError('notFound', `Unknown event type: ${name}`, { kind: 'event' });
        return entry;
    }

    list(): RegisteredEvent[] {
        return [...this.#entries.values()];
    }

    remove(name: string): RegisteredEvent | undefined {
        const entry = this.#entries.get(name);
        this.#entries.delete(name);
        return entry;
    }
}
