/**
 * Event Emitter System
 *
 * A lightweight, type-safe event emitter for SDK observability.
 *
 * Design decisions:
 * - Custom implementation instead of Node's EventEmitter for cross-platform compatibility
 * - Works in Node.js, browsers, and edge runtimes
 * - Type-safe event names and payloads
 * - Modern API with unsubscribe function returned from `on()`
 */

/**
 * Type-safe event emitter interface.
 * Events is a record mapping event names to their payload types.
 */
export interface McpEventEmitter<Events extends Record<string, unknown>> {
    /**
     * Subscribe to an event.
     * @param event - The event name
     * @param listener - The callback to invoke when the event is emitted
     * @returns An unsubscribe function
     */
    on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): () => void;

    /**
     * Subscribe to an event for a single occurrence.
     * @param event - The event name
     * @param listener - The callback to invoke when the event is emitted
     * @returns An unsubscribe function
     */
    once<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): () => void;

    /**
     * Unsubscribe from an event.
     * @param event - The event name
     * @param listener - The callback to remove
     */
    off<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): void;

    /**
     * Emit an event with data.
     * @param event - The event name
     * @param data - The event payload
     */
    emit<K extends keyof Events>(event: K, data: Events[K]): void;
}

/**
 * Type-safe event emitter implementation.
 * Provides a minimal, cross-platform event system.
 */
export class TypedEventEmitter<Events extends Record<string, unknown>> implements McpEventEmitter<Events> {
    private _listeners = new Map<keyof Events, Set<(data: unknown) => void>>();

    /**
     * Subscribe to an event.
     *
     * @param event - The event name
     * @param listener - The callback to invoke when the event is emitted
     * @returns An unsubscribe function
     *
     * @example
     * ```typescript
     * const unsubscribe = emitter.on('connection:opened', ({ sessionId }) => {
     *   console.log(`Connected: ${sessionId}`);
     * });
     *
     * // Later, to unsubscribe:
     * unsubscribe();
     * ```
     */
    on<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): () => void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        const listeners = this._listeners.get(event)!;
        listeners.add(listener as (data: unknown) => void);

        // Return unsubscribe function
        return () => this.off(event, listener);
    }

    /**
     * Subscribe to an event for a single occurrence.
     * The listener is automatically removed after the first invocation.
     *
     * @param event - The event name
     * @param listener - The callback to invoke when the event is emitted
     * @returns An unsubscribe function
     */
    once<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): () => void {
        const wrapper = (data: Events[K]): void => {
            this.off(event, wrapper);
            listener(data);
        };
        return this.on(event, wrapper);
    }

    /**
     * Unsubscribe from an event.
     *
     * @param event - The event name
     * @param listener - The callback to remove
     */
    off<K extends keyof Events>(event: K, listener: (data: Events[K]) => void): void {
        const listeners = this._listeners.get(event);
        if (listeners) {
            listeners.delete(listener as (data: unknown) => void);
            if (listeners.size === 0) {
                this._listeners.delete(event);
            }
        }
    }

    /**
     * Emit an event with data.
     * All registered listeners for the event will be invoked synchronously.
     *
     * @param event - The event name
     * @param data - The event payload
     */
    emit<K extends keyof Events>(event: K, data: Events[K]): void {
        const listeners = this._listeners.get(event);
        if (listeners) {
            // Create a copy to allow listeners to unsubscribe during iteration
            for (const listener of listeners) {
                try {
                    listener(data);
                } catch {
                    // Silently ignore listener errors to prevent one listener
                    // from breaking others. Errors should be handled by the listener.
                }
            }
        }
    }

    /**
     * Check if any listeners are registered for an event.
     *
     * @param event - The event name
     * @returns true if there are listeners for the event
     */
    hasListeners<K extends keyof Events>(event: K): boolean {
        const listeners = this._listeners.get(event);
        return listeners !== undefined && listeners.size > 0;
    }

    /**
     * Get the number of listeners for an event.
     *
     * @param event - The event name
     * @returns The number of listeners
     */
    listenerCount<K extends keyof Events>(event: K): number {
        const listeners = this._listeners.get(event);
        return listeners?.size ?? 0;
    }

    /**
     * Remove all listeners for a specific event, or all events if no event is specified.
     *
     * @param event - Optional event name. If not provided, removes all listeners.
     */
    removeAllListeners<K extends keyof Events>(event?: K): void {
        if (event === undefined) {
            this._listeners.clear();
        } else {
            this._listeners.delete(event);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pre-defined Event Maps for SDK Components
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Events emitted by McpServer.
 */
export interface McpServerEvents {
    [key: string]: unknown;

    /**
     * Emitted when a tool is registered.
     */
    'tool:registered': { name: string; tool: unknown };

    /**
     * Emitted when a tool is removed.
     */
    'tool:removed': { name: string };

    /**
     * Emitted when a resource is registered.
     */
    'resource:registered': { uri: string; resource: unknown };

    /**
     * Emitted when a resource is removed.
     */
    'resource:removed': { uri: string };

    /**
     * Emitted when a prompt is registered.
     */
    'prompt:registered': { name: string; prompt: unknown };

    /**
     * Emitted when a prompt is removed.
     */
    'prompt:removed': { name: string };

    /**
     * Emitted when a connection is opened.
     */
    'connection:opened': { sessionId: string };

    /**
     * Emitted when a connection is closed.
     */
    'connection:closed': { sessionId: string; reason?: string };

    /**
     * Emitted when an error occurs.
     */
    error: { error: Error; context?: string };
}

/**
 * Events emitted by Client.
 */
export interface McpClientEvents {
    [key: string]: unknown;

    /**
     * Emitted when a connection is opened.
     */
    'connection:opened': { sessionId: string };

    /**
     * Emitted when a connection is closed.
     */
    'connection:closed': { sessionId: string; reason?: string };

    /**
     * Emitted when a tool call is made.
     */
    'tool:called': { name: string; args: unknown };

    /**
     * Emitted when a tool call returns a result.
     */
    'tool:result': { name: string; result: unknown };

    /**
     * Emitted when an error occurs.
     */
    error: { error: Error; context?: string };
}

/**
 * Creates a new typed event emitter for McpServer events.
 */
export function createServerEventEmitter(): TypedEventEmitter<McpServerEvents> {
    return new TypedEventEmitter<McpServerEvents>();
}

/**
 * Creates a new typed event emitter for Client events.
 */
export function createClientEventEmitter(): TypedEventEmitter<McpClientEvents> {
    return new TypedEventEmitter<McpClientEvents>();
}
