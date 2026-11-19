import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';

import type { CheckContext } from './types';

export interface ContextFields {
    name: string;
    subscriptionId: string;
    principal: string | null;
    mode: DeliveryMode;
    signal: AbortSignal;
    maxEvents?: number;
    maxAgeMs?: number;
}

// The frozen `ctx` handed to event callbacks; the hints are present only when given.
export function makeContext(fields: ContextFields): CheckContext {
    const { name, subscriptionId, principal, mode, signal, maxEvents, maxAgeMs } = fields;
    return Object.freeze({
        name,
        subscriptionId,
        principal,
        mode,
        signal,
        ...(maxEvents === undefined ? {} : { maxEvents }),
        ...(maxAgeMs === undefined ? {} : { maxAgeMs })
    });
}
