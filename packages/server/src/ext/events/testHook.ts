import type { SubscriptionSource } from './extension';

// Where an EventsExtension keeps its test hook; `Symbol.for` so separately bundled copies find it.
export const EVENTS_TEST_HOOK = Symbol.for('mcp.events.testHook');

export interface EventsTestState {
    readonly trustedOrigins: readonly string[];
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
}

export function installTestHook(target: object, hook: EventsTestHook): void {
    Object.defineProperty(target, EVENTS_TEST_HOOK, { value: hook, enumerable: false });
}
