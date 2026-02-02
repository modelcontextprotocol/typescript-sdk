import type {
    Icon,
    ReadResourceResult,
    RequestHandlerExtra,
    Resource,
    ServerNotification,
    ServerRequest
} from '@modelcontextprotocol/core';

import type { OnRemove, OnRename, OnUpdate } from './types.js';

/**
 * Additional, optional information for annotating a resource.
 */
export type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (
    uri: URL,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => ReadResourceResult | Promise<ReadResourceResult>;

/**
 * Protocol fields for Resource, derived from the Resource type.
 */
export type ResourceProtocolFields = Resource;

/**
 * Configuration for creating a RegisteredResource.
 * Combines protocol fields with SDK-specific callback.
 */
export type ResourceConfig = ResourceProtocolFields & {
    readCallback: ReadResourceCallback;
};

/**
 * A registered resource in the MCP server.
 * Provides methods to enable, disable, update, rename, and remove the resource.
 */
export class RegisteredResource {
    // Protocol fields - stored together for easy spreading
    #protocolFields: ResourceProtocolFields;

    // SDK-specific fields - separate from protocol
    #readCallback: ReadResourceCallback;
    #enabled: boolean = true;

    // Callbacks for McpServer communication
    readonly #onUpdate: OnUpdate;
    readonly #onRename: OnRename<RegisteredResource>;
    readonly #onRemove: OnRemove;

    constructor(config: ResourceConfig, onUpdate: OnUpdate, onRename: OnRename<RegisteredResource>, onRemove: OnRemove) {
        // Separate protocol fields from SDK fields
        const { readCallback, ...protocolFields } = config;
        this.#protocolFields = protocolFields;
        this.#readCallback = readCallback;

        this.#onUpdate = onUpdate;
        this.#onRename = onRename;
        this.#onRemove = onRemove;
    }

    // Protocol field getters (delegate to #protocolFields)
    get name(): string {
        return this.#protocolFields.name;
    }
    get title(): string | undefined {
        return this.#protocolFields.title;
    }
    get uri(): string {
        return this.#protocolFields.uri;
    }
    get description(): string | undefined {
        return this.#protocolFields.description;
    }
    get mimeType(): string | undefined {
        return this.#protocolFields.mimeType;
    }
    get icons(): Icon[] | undefined {
        return this.#protocolFields.icons;
    }
    get annotations(): Resource['annotations'] | undefined {
        return this.#protocolFields.annotations;
    }
    get _meta(): Record<string, unknown> | undefined {
        return this.#protocolFields._meta;
    }

    /**
     * Gets the resource metadata (all fields except uri and name).
     */
    get metadata(): ResourceMetadata {
        return {
            title: this.#protocolFields.title,
            description: this.#protocolFields.description,
            mimeType: this.#protocolFields.mimeType,
            icons: this.#protocolFields.icons,
            annotations: this.#protocolFields.annotations,
            _meta: this.#protocolFields._meta
        };
    }

    // SDK-specific getters
    get readCallback(): ReadResourceCallback {
        return this.#readCallback;
    }
    get enabled(): boolean {
        return this.#enabled;
    }

    /**
     * Enables the resource.
     * @returns this for chaining
     */
    public enable(): this {
        if (!this.#enabled) {
            this.#enabled = true;
            this.#onUpdate();
        }
        return this;
    }

    /**
     * Disables the resource.
     * @returns this for chaining
     */
    public disable(): this {
        if (this.#enabled) {
            this.#enabled = false;
            this.#onUpdate();
        }
        return this;
    }

    /**
     * Changes the resource's URI (which is also the registry key).
     * @param newUri - The new URI for the resource
     * @returns this for chaining
     */
    public changeUri(newUri: string): this {
        if (newUri !== this.#protocolFields.uri) {
            const oldUri = this.#protocolFields.uri;
            this.#protocolFields.uri = newUri;
            this.#onRename(oldUri, newUri, this);
        }
        return this;
    }

    /**
     * Removes the resource from the registry.
     */
    public remove(): void {
        this.#onRemove(this.#protocolFields.uri);
    }

    /**
     * Updates the resource's properties.
     * @param updates - The properties to update
     */
    public update(
        updates: Partial<ResourceConfig> & {
            enabled?: boolean;
            uri?: string | null;
            callback?: ReadResourceCallback;
        }
    ): void {
        const {
            uri: uriUpdate,
            enabled: enabledUpdate,
            readCallback: readCallbackUpdate,
            callback: callbackUpdate,
            ...protocolUpdates
        } = updates;

        // Handle uri change (change key or remove)
        if (uriUpdate !== undefined) {
            if (uriUpdate === null) {
                this.remove();
                return;
            }
            this.changeUri(uriUpdate);
        }

        // Extract special fields, update protocol fields in one go
        Object.assign(this.#protocolFields, protocolUpdates);

        // Update SDK-specific fields (support both readCallback and callback)
        if (readCallbackUpdate !== undefined) this.#readCallback = readCallbackUpdate;
        if (callbackUpdate !== undefined) this.#readCallback = callbackUpdate;

        // Handle enabled (triggers its own notification)
        if (enabledUpdate === undefined) {
            this.#onUpdate();
        } else if (enabledUpdate) {
            this.enable();
        } else {
            this.disable();
        }
    }

    /**
     * Converts to the Resource protocol type (for list responses).
     */
    public toProtocolResource(): Resource {
        return { ...this.#protocolFields };
    }
}
