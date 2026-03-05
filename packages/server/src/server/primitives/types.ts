/**
 * Shared callback types for registered primitives (tools, prompts, resources).
 * These callbacks are passed to class constructors for McpServer communication.
 */

/**
 * Callback invoked when a registered item is updated (properties changed, enabled/disabled).
 */
export type OnUpdate = () => void;

/**
 * Callback invoked when a registered item is renamed.
 * @param oldName - The previous name
 * @param newName - The new name
 * @param item - The item being renamed
 */
export type OnRename<T> = (oldName: string, newName: string, item: T) => void;

/**
 * Callback invoked when a registered item is removed.
 * @param name - The name of the item being removed
 */
export type OnRemove = (name: string) => void;
