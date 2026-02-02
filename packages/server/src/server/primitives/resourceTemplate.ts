import type {
    Icon,
    ListResourcesResult,
    ReadResourceResult,
    RequestHandlerExtra,
    ResourceTemplateType,
    ServerNotification,
    ServerRequest,
    Variables
} from '@modelcontextprotocol/core';
import { UriTemplate } from '@modelcontextprotocol/core';

import type { ResourceMetadata } from './resource.js';
import type { OnRemove, OnRename, OnUpdate } from './types.js';

/**
 * Callback to list all resources matching a given template.
 */
export type ListResourcesCallback = (
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
export type ReadResourceTemplateCallback = (
    uri: URL,
    variables: Variables,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
) => ReadResourceResult | Promise<ReadResourceResult>;

/**
 * A callback to complete one variable within a resource template's URI template.
 */
export type CompleteResourceTemplateCallback = (
    value: string,
    context?: {
        arguments?: Record<string, string>;
    }
) => string[] | Promise<string[]>;

/**
 * A resource template combines a URI pattern with optional functionality to enumerate
 * all resources matching that pattern.
 */
export class ResourceTemplate {
    #uriTemplate: UriTemplate;

    constructor(
        uriTemplate: string | UriTemplate,
        private _callbacks: {
            /**
             * A callback to list all resources matching this template.
             * This is required to be specified, even if `undefined`, to avoid accidentally forgetting resource listing.
             */
            list: ListResourcesCallback | undefined;

            /**
             * An optional callback to autocomplete variables within the URI template.
             * Useful for clients and users to discover possible values.
             */
            complete?: {
                [variable: string]: CompleteResourceTemplateCallback;
            };
        }
    ) {
        this.#uriTemplate = typeof uriTemplate === 'string' ? new UriTemplate(uriTemplate) : uriTemplate;
    }

    /**
     * Gets the URI template pattern.
     */
    get uriTemplate(): UriTemplate {
        return this.#uriTemplate;
    }

    /**
     * Gets the list callback, if one was provided.
     */
    get listCallback(): ListResourcesCallback | undefined {
        return this._callbacks.list;
    }

    /**
     * Gets the callback for completing a specific URI template variable, if one was provided.
     */
    completeCallback(variable: string): CompleteResourceTemplateCallback | undefined {
        return this._callbacks.complete?.[variable];
    }
}

/**
 * Protocol fields for ResourceTemplate, derived from the ResourceTemplateType protocol type.
 * Note: The SDK ResourceTemplate class is separate from the protocol type.
 */
export type ResourceTemplateProtocolFields = Omit<ResourceTemplateType, 'uriTemplate'> & {
    resourceTemplate: ResourceTemplate;
};

/**
 * Configuration for creating a RegisteredResourceTemplate.
 * Combines protocol fields with SDK-specific callback.
 */
export type ResourceTemplateConfig = ResourceTemplateProtocolFields & {
    readCallback: ReadResourceTemplateCallback;
};

/**
 * A registered resource template in the MCP server.
 * Provides methods to enable, disable, update, rename, and remove the resource template.
 */
export class RegisteredResourceTemplate {
    // Protocol fields - stored together for easy spreading
    #protocolFields: ResourceTemplateProtocolFields;

    // SDK-specific fields - separate from protocol
    #readCallback: ReadResourceTemplateCallback;
    #enabled: boolean = true;

    // Callbacks for McpServer communication
    readonly #onUpdate: OnUpdate;
    readonly #onRename: OnRename<RegisteredResourceTemplate>;
    readonly #onRemove: OnRemove;

    constructor(config: ResourceTemplateConfig, onUpdate: OnUpdate, onRename: OnRename<RegisteredResourceTemplate>, onRemove: OnRemove) {
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
    get description(): string | undefined {
        return this.#protocolFields.description;
    }
    get mimeType(): string | undefined {
        return this.#protocolFields.mimeType;
    }
    get icons(): Icon[] | undefined {
        return this.#protocolFields.icons;
    }
    get annotations(): ResourceTemplateType['annotations'] | undefined {
        return this.#protocolFields.annotations;
    }
    get _meta(): Record<string, unknown> | undefined {
        return this.#protocolFields._meta;
    }
    get resourceTemplate(): ResourceTemplate {
        return this.#protocolFields.resourceTemplate;
    }

    /**
     * Gets the resource metadata (all fields except name and resourceTemplate).
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
    get readCallback(): ReadResourceTemplateCallback {
        return this.#readCallback;
    }
    get enabled(): boolean {
        return this.#enabled;
    }

    /**
     * Enables the resource template.
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
     * Disables the resource template.
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
     * Renames the resource template.
     * @param newName - The new name for the resource template
     * @returns this for chaining
     */
    public rename(newName: string): this {
        if (newName !== this.#protocolFields.name) {
            const oldName = this.#protocolFields.name;
            this.#protocolFields.name = newName;
            this.#onRename(oldName, newName, this);
        }
        return this;
    }

    /**
     * Removes the resource template from the registry.
     */
    public remove(): void {
        this.#onRemove(this.#protocolFields.name);
    }

    /**
     * Updates the resource template's properties.
     * @param updates - The properties to update
     */
    public update(
        updates: Partial<ResourceTemplateConfig> & {
            enabled?: boolean;
            name?: string | null;
            template?: ResourceTemplate;
            callback?: ReadResourceTemplateCallback;
        }
    ): void {
        const {
            name: nameUpdate,
            enabled: enabledUpdate,
            template: templateUpdate,
            readCallback: readCallbackUpdate,
            callback: callbackUpdate,
            resourceTemplate: resourceTemplateUpdate,
            ...protocolUpdates
        } = updates;

        // Handle name change (rename or remove)
        if (nameUpdate !== undefined) {
            if (nameUpdate === null) {
                this.remove();
                return;
            }
            this.rename(nameUpdate);
        }

        // Extract special fields, update protocol fields in one go
        Object.assign(this.#protocolFields, protocolUpdates);

        // Handle template specially (maps to resourceTemplate in protocol fields)
        if (templateUpdate !== undefined) {
            this.#protocolFields.resourceTemplate = templateUpdate;
        }
        if (resourceTemplateUpdate !== undefined) {
            this.#protocolFields.resourceTemplate = resourceTemplateUpdate;
        }

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
     * Converts to the ResourceTemplate protocol type (for list responses).
     */
    public toProtocolResourceTemplate(): ResourceTemplateType {
        const { resourceTemplate, ...rest } = this.#protocolFields;
        return {
            ...rest,
            uriTemplate: resourceTemplate.uriTemplate.toString()
        };
    }
}
