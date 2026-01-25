/**
 * Base Registry
 *
 * Abstract base class for managing collections of registered entities
 * (tools, resources, prompts). Provides common functionality for
 * CRUD operations and notifications.
 */

/**
 * Base interface for all registered definitions
 */
export interface RegisteredDefinition {
    /**
     * Whether the definition is currently enabled
     */
    enabled: boolean;

    /**
     * Enable the definition
     */
    enable(): this;

    /**
     * Disable the definition
     */
    disable(): this;

    /**
     * Remove the definition from its registry
     */
    remove(): void;
}

/**
 * Callback type for registry change notifications
 */
export type RegistryNotifyCallback = () => void;

/**
 * Abstract base class for registries.
 * Provides common functionality for managing collections of registered entities.
 *
 * @template T - The type of registered entity this registry manages
 */
export abstract class BaseRegistry<T extends RegisteredDefinition> {
    /**
     * Internal storage for registered items
     */
    protected _items = new Map<string, T>();

    /**
     * Optional callback for change notifications.
     * Can be set after construction via setNotifyCallback().
     */
    protected _notifyCallback?: RegistryNotifyCallback;

    /**
     * Sets or updates the notification callback.
     * This allows the callback to be bound after construction (e.g., by McpServer
     * when using registries created by the builder).
     *
     * @param callback - The callback to invoke when the registry changes
     */
    setNotifyCallback(callback: RegistryNotifyCallback): void {
        this._notifyCallback = callback;
    }

    /**
     * Called when the registry contents change.
     * Invokes the notification callback if one is set.
     */
    protected notifyChanged(): void {
        this._notifyCallback?.();
    }

    /**
     * Checks if an item with the given ID exists in the registry.
     *
     * @param id - The identifier to check
     * @returns true if the item exists
     */
    has(id: string): boolean {
        return this._items.has(id);
    }

    /**
     * Gets an item by its ID.
     *
     * @param id - The identifier of the item
     * @returns The item or undefined if not found
     */
    get(id: string): T | undefined {
        return this._items.get(id);
    }

    /**
     * Gets all items in the registry as a read-only map.
     *
     * @returns A read-only map of all items
     */
    getAll(): ReadonlyMap<string, T> {
        return this._items;
    }

    /**
     * Gets all items as an array.
     *
     * @returns Array of all registered items
     */
    values(): T[] {
        return [...this._items.values()];
    }

    /**
     * Gets all enabled items as an array.
     *
     * @returns Array of enabled items
     */
    getEnabled(): T[] {
        return this.values().filter(item => item.enabled);
    }

    /**
     * Gets all disabled items as an array.
     *
     * @returns Array of disabled items
     */
    getDisabled(): T[] {
        return this.values().filter(item => !item.enabled);
    }

    /**
     * Gets the number of items in the registry.
     */
    get size(): number {
        return this._items.size;
    }

    /**
     * Removes an item from the registry.
     *
     * @param id - The identifier of the item to remove
     * @returns true if the item was removed, false if it didn't exist
     */
    remove(id: string): boolean {
        const deleted = this._items.delete(id);
        if (deleted) {
            this.notifyChanged();
        }
        return deleted;
    }

    /**
     * Disables all items in the registry.
     */
    disableAll(): void {
        let changed = false;
        for (const item of this._items.values()) {
            if (item.enabled) {
                item.disable();
                changed = true;
            }
        }
        if (changed) {
            this.notifyChanged();
        }
    }

    /**
     * Enables all items in the registry.
     */
    enableAll(): void {
        let changed = false;
        for (const item of this._items.values()) {
            if (!item.enabled) {
                item.enable();
                changed = true;
            }
        }
        if (changed) {
            this.notifyChanged();
        }
    }

    /**
     * Clears all items from the registry.
     */
    clear(): void {
        if (this._items.size > 0) {
            this._items.clear();
            this.notifyChanged();
        }
    }

    /**
     * Internal method to add or update an item in the registry.
     * Used by subclasses during registration.
     *
     * @param id - The identifier for the item
     * @param item - The item to add
     */
    protected _set(id: string, item: T): void {
        this._items.set(id, item);
    }

    /**
     * Internal method to rename an item in the registry.
     *
     * @param oldId - The current identifier
     * @param newId - The new identifier
     * @returns true if renamed successfully
     */
    protected _rename(oldId: string, newId: string): boolean {
        const item = this._items.get(oldId);
        if (!item) {
            return false;
        }
        if (oldId === newId) {
            return true;
        }
        if (this._items.has(newId)) {
            throw new Error(`Cannot rename: '${newId}' already exists`);
        }
        this._items.delete(oldId);
        this._items.set(newId, item);
        this.notifyChanged();
        return true;
    }
}
