import type { EmitFanOut, SubscriptionSource } from './extension';

// Where an EventsExtension keeps its test hook; `Symbol.for` so separately bundled copies find it.
export const EVENTS_TEST_HOOK = Symbol.for('mcp.events.testHook');

export interface EventsTestState {
    readonly trustedOrigins: readonly string[];
    // Events the emit buffer holds, per event type.
    readonly emitBuffer: Readonly<Record<string, number>>;
    // Live poll leases.
    readonly pollLeases: number;
    // Open push streams, counting those still starting.
    readonly pushStreams: number;
    // Webhook subscriptions this process holds delivery state (watermark, status, retries) for.
    readonly webhookSubscriptions: number;
    // Webhook subscriptions this process watches with an expiry timer (and a check type's loop), after handling their subscribe or refresh.
    readonly webhookExpiryTimers: number;
}

// Internal controls for tests and the conformance fixture; never part of the public API or its declarations.
export interface EventsTestHook {
    // Bumped by every simulated restart.
    generation(): number;
    // Drops the extension's process-memory state, as a process restart would.
    restart(): void;
    state(): EventsTestState;
    addTrustedOrigin(origin: string): void;
    addSource(source: SubscriptionSource): void;
    addFanOut(fanOut: EmitFanOut): void;
}

export function installTestHook(target: object, hook: EventsTestHook): void {
    Object.defineProperty(target, EVENTS_TEST_HOOK, { value: hook, enumerable: false });
}
