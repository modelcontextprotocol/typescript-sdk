/**
 * Provides a simple, type-safe event notification implementation. This module allows components to implement the
 * observer pattern with minimal boilerplate and proper type checking.
 */

/**
 * A type-safe event notifier that manages event listeners and notifications.
 *
 * @template T The type of events this notifier will handle
 * @template E The type of error that can be handled (defaults to Error)
 *
 *   EventNotifier provides:
 *
 *   - Type-safe event subscriptions via `onEvent`
 *   - Synchronized event notifications via `notify`
 *   - Automatic cleanup of resources via `close`
 *   - Status tracking via `active` property
 *   - Error handling via optional error callback
 */
export type EventNotifier<T, E = Error> = {
  /**
   * Registers a listener function to be called when events are notified. Listeners are notified in the order they
   * were registered.
   *
   * @example
   *
   * ```ts
   * const notifier = createEventNotifier<string>();
   * const subscription = notifier.onEvent((message) => {
   *   console.log(`Received message: ${message}`);
   * });
   *
   * // Later, to stop listening:
   * subscription.close();
   * ```
   *
   * @param listener A function that will be called with the notified event
   * @returns A SyncCloseable that, when closed, will unregister the listener
   */
  onEvent: (listener: (event: T) => unknown) => { close: () => void };

  /**
   * Notifies all registered listeners with the provided event.
   *
   * This method:
   *
   * - Calls all registered listeners with the event in their registration order
   * - Ignores errors thrown by listeners (they won't affect other listeners)
   * - Ignores returned promises (results are not awaited)
   * - Does nothing if there are no listeners
   * - If the event is a function, it will be called if there are listeners and its return value will be
   *   used as the event.
   *
   * @example
   *
   * ```ts
   * const notifier = createEventNotifier<{ type: string; data: unknown }>();
   * notifier.onEvent((event) => {
   *   console.log(`Received ${event.type} with data:`, event.data);
   * });
   *
   * notifier.notify({ type: 'update', data: { id: 123, status: 'complete' } });
   * ```
   *
   * @param event The event to send to all listeners or a function that returns such event.
   */
  notify: (event: T | (() => T)) => void;

  /**
   * Sets an error handler for the notifier. This handler will be called when a listener throws an error.
   *
   * @param handler A function that will be called with any errors thrown by listeners
   */
  onError: (handler: (error: E) => void) => void;

  /**
   * Closes the notifier and removes all listeners.
   *
   * @warning Failing to call close() on subscriptions or the notifier itself may lead to memory leaks.
   */
  close: () => void;
};

/**
 * Creates a type-safe event notifier.
 *
 * @example
 *
 * ```ts
 * // Simple string event notifier
 * const stringNotifier = createEventNotifier<string>();
 *
 * // Complex object event notifier
 * interface UserEvent {
 *   type: 'created' | 'updated' | 'deleted';
 *   userId: number;
 *   data?: Record<string, unknown>;
 * }
 * const userNotifier = createEventNotifier<UserEvent>();
 * ```
 *
 * @template T The type of events this notifier will handle
 * @template E The type of error that can be handled (defaults to Error)
 * @returns A new EventNotifier instance
 */
export const createEventNotifier = <T, E = Error>(): EventNotifier<T, E> => {
  const listeners = new Set<(event: T) => unknown>();
  let errorHandler: ((error: E) => void) | undefined;

  return {
    close: () => {
      listeners.clear();
      errorHandler = undefined;
    },

    onEvent: (listener) => {
      listeners.add(listener);
      return {
        close: () => {
          listeners.delete(listener);
        },
      };
    },

    notify: (event: T | (() => T)) => {
      if (!listeners.size) {
        return;
      }

      if (typeof event === "function") {
        event = (event as () => T)();
      }

      for (const listener of listeners) {
        try {
          void listener(event);
        } catch (error) {
          if (errorHandler) {
            errorHandler(error as E);
          }
        }
      }
    },

    onError: (handler) => {
      errorHandler = handler;
    },
  };
};
