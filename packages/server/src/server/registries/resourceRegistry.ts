/**
 * Resource Registry
 *
 * Manages registration and retrieval of resources and resource templates.
 * Provides class-based RegisteredResourceEntity entities with proper encapsulation.
 */

import type { Resource, ResourceTemplateType as ResourceTemplateProtocol, Variables } from '@modelcontextprotocol/core';

import type { ReadResourceCallback, ReadResourceTemplateCallback } from '../../types/types.js';
import type { ResourceMetadata, ResourceTemplate } from '../mcp.js';
import type { RegisteredDefinition } from './baseRegistry.js';
import { BaseRegistry } from './baseRegistry.js';

/**
 * Configuration for registering a static resource
 */
export interface ResourceConfig {
    name: string;
    uri: string;
    title?: string;
    description?: string;
    mimeType?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceCallback;
}

/**
 * Configuration for registering a resource template
 */
export interface ResourceTemplateConfig {
    name: string;
    template: ResourceTemplate;
    title?: string;
    description?: string;
    mimeType?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceTemplateCallback;
}

/**
 * Updates that can be applied to a registered resource
 */
export interface ResourceUpdates {
    name?: string;
    uri?: string | null;
    title?: string;
    description?: string;
    mimeType?: string;
    metadata?: ResourceMetadata;
    callback?: ReadResourceCallback;
    enabled?: boolean;
}

/**
 * Updates that can be applied to a registered resource template
 */
export interface ResourceTemplateUpdates {
    name?: string | null;
    title?: string;
    description?: string;
    mimeType?: string;
    template?: ResourceTemplate;
    metadata?: ResourceMetadata;
    callback?: ReadResourceTemplateCallback;
    enabled?: boolean;
}

/**
 * Class-based representation of a registered static resource.
 * Provides methods for managing the resource's lifecycle.
 */
export class RegisteredResourceEntity implements RegisteredDefinition {
    private _name: string;
    private _uri: string;
    private _enabled: boolean = true;
    private readonly _registry: ResourceRegistry;

    private _title?: string;
    private _description?: string;
    private _mimeType?: string;
    private _metadata?: ResourceMetadata;
    private _readCallback: ReadResourceCallback;

    constructor(config: ResourceConfig, registry: ResourceRegistry) {
        this._name = config.name;
        this._uri = config.uri;
        this._registry = registry;
        this._title = config.title;
        this._description = config.description;
        this._mimeType = config.mimeType;
        this._metadata = config.metadata;
        this._readCallback = config.readCallback;
    }

    /** The resource's name */
    get name(): string {
        return this._name;
    }

    /** The resource's URI */
    get uri(): string {
        return this._uri;
    }

    /** Whether the resource is currently enabled */
    get enabled(): boolean {
        return this._enabled;
    }

    /** The resource's title */
    get title(): string | undefined {
        return this._title;
    }

    /** The resource's description */
    get description(): string | undefined {
        return this._description;
    }

    /** The resource's MIME type */
    get mimeType(): string | undefined {
        return this._mimeType;
    }

    /** The resource's metadata */
    get metadata(): ResourceMetadata | undefined {
        return this._metadata;
    }

    /** The resource's read callback */
    get readCallback(): ReadResourceCallback {
        return this._readCallback;
    }

    /**
     * Enables the resource
     */
    enable(): this {
        if (!this._enabled) {
            this._enabled = true;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Disables the resource
     */
    disable(): this {
        if (this._enabled) {
            this._enabled = false;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Removes the resource from its registry
     */
    remove(): void {
        this._registry.remove(this._uri);
    }

    /**
     * Updates the resource's properties
     *
     * @param updates - The updates to apply
     */
    update(updates: ResourceUpdates): void {
        if (updates.uri !== undefined) {
            if (updates.uri === null) {
                this.remove();
                return;
            }
            // Handle URI change - need to re-register under new URI
            const oldUri = this._uri;
            this._uri = updates.uri;
            this._registry['_items'].delete(oldUri);
            this._registry['_items'].set(updates.uri, this);
        }
        if (updates.name !== undefined) this._name = updates.name;
        if (updates.title !== undefined) this._title = updates.title;
        if (updates.description !== undefined) this._description = updates.description;
        if (updates.mimeType !== undefined) this._mimeType = updates.mimeType;
        if (updates.metadata !== undefined) this._metadata = updates.metadata;
        if (updates.callback !== undefined) this._readCallback = updates.callback;
        if (updates.enabled === undefined) {
            this._registry['notifyChanged']();
        } else {
            if (updates.enabled) {
                this.enable();
            } else {
                this.disable();
            }
        }
    }

    /**
     * Converts to the Resource protocol type (for list responses)
     */
    toProtocolResource(): Resource {
        return {
            uri: this._uri,
            name: this._name,
            title: this._title,
            description: this._description,
            mimeType: this._mimeType,
            ...this._metadata
        };
    }
}

/**
 * Class-based representation of a registered resource template.
 * Provides methods for managing the template's lifecycle.
 */
export class RegisteredResourceTemplateEntity implements RegisteredDefinition {
    private _name: string;
    private _enabled: boolean = true;
    private readonly _registry: ResourceTemplateRegistry;

    private _title?: string;
    private _description?: string;
    private _mimeType?: string;
    private _metadata?: ResourceMetadata;
    private _template: ResourceTemplate;
    private _readCallback: ReadResourceTemplateCallback;

    constructor(config: ResourceTemplateConfig, registry: ResourceTemplateRegistry) {
        this._name = config.name;
        this._registry = registry;
        this._title = config.title;
        this._description = config.description;
        this._mimeType = config.mimeType;
        this._metadata = config.metadata;
        this._template = config.template;
        this._readCallback = config.readCallback;
    }

    /** The template's name (identifier) */
    get name(): string {
        return this._name;
    }

    /** Whether the template is currently enabled */
    get enabled(): boolean {
        return this._enabled;
    }

    /** The template's title */
    get title(): string | undefined {
        return this._title;
    }

    /** The template's description */
    get description(): string | undefined {
        return this._description;
    }

    /** The template's MIME type */
    get mimeType(): string | undefined {
        return this._mimeType;
    }

    /** The template's metadata */
    get metadata(): ResourceMetadata | undefined {
        return this._metadata;
    }

    /** The resource template */
    get template(): ResourceTemplate {
        return this._template;
    }

    /** Alias for template for backward compatibility */
    get resourceTemplate(): ResourceTemplate {
        return this._template;
    }

    /** The template's read callback */
    get readCallback(): ReadResourceTemplateCallback {
        return this._readCallback;
    }

    /**
     * Enables the template
     */
    enable(): this {
        if (!this._enabled) {
            this._enabled = true;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Disables the template
     */
    disable(): this {
        if (this._enabled) {
            this._enabled = false;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Removes the template from its registry
     */
    remove(): void {
        this._registry.remove(this._name);
    }

    /**
     * Renames the template
     *
     * @param newName - The new name for the template
     */
    rename(newName: string): this {
        this._registry['_rename'](this._name, newName);
        this._name = newName;
        return this;
    }

    /**
     * Updates the template's properties
     *
     * @param updates - The updates to apply
     */
    update(updates: ResourceTemplateUpdates): void {
        if (updates.name !== undefined) {
            if (updates.name === null) {
                this.remove();
                return;
            }
            this.rename(updates.name);
        }
        if (updates.title !== undefined) this._title = updates.title;
        if (updates.description !== undefined) this._description = updates.description;
        if (updates.mimeType !== undefined) this._mimeType = updates.mimeType;
        if (updates.metadata !== undefined) this._metadata = updates.metadata;
        if (updates.template !== undefined) this._template = updates.template;
        if (updates.callback !== undefined) this._readCallback = updates.callback;
        if (updates.enabled === undefined) {
            this._registry['notifyChanged']();
        } else {
            if (updates.enabled) {
                this.enable();
            } else {
                this.disable();
            }
        }
    }

    /**
     * Converts to the ResourceTemplate protocol type (for list responses)
     */
    toProtocolResourceTemplate(): ResourceTemplateProtocol {
        return {
            name: this._name,
            uriTemplate: this._template.uriTemplate.toString(),
            title: this._title,
            description: this._description,
            mimeType: this._mimeType,
            ...this._metadata
        };
    }
}

/**
 * Registry for managing static resources.
 * Resources are keyed by URI.
 */
export class ResourceRegistry extends BaseRegistry<RegisteredResourceEntity> {
    /**
     * Creates a new ResourceRegistry.
     *
     * @param sendNotification - Optional callback to invoke when the resource list changes.
     *                           Can be set later via setNotifyCallback().
     */
    constructor(sendNotification?: () => void) {
        super();
        if (sendNotification) {
            this.setNotifyCallback(sendNotification);
        }
    }

    /**
     * Registers a new resource.
     *
     * @param config - The resource configuration
     * @returns The registered resource
     * @throws If a resource with the same URI already exists
     */
    register(config: ResourceConfig): RegisteredResourceEntity {
        if (this._items.has(config.uri)) {
            throw new Error(`Resource '${config.uri}' is already registered`);
        }

        const resource = new RegisteredResourceEntity(config, this);
        this._set(config.uri, resource);
        this.notifyChanged();
        return resource;
    }

    /**
     * Gets the list of enabled resources in protocol format.
     *
     * @returns Array of Resource objects for the protocol response
     */
    getProtocolResources(): Resource[] {
        return this.getEnabled().map(resource => resource.toProtocolResource());
    }

    /**
     * Gets a resource by URI.
     *
     * @param uri - The resource URI
     * @returns The registered resource or undefined
     */
    getResource(uri: string): RegisteredResourceEntity | undefined {
        return this.get(uri);
    }
}

/**
 * Registry for managing resource templates.
 * Templates are keyed by name.
 */
export class ResourceTemplateRegistry extends BaseRegistry<RegisteredResourceTemplateEntity> {
    /**
     * Creates a new ResourceTemplateRegistry.
     *
     * @param sendNotification - Optional callback to invoke when the template list changes.
     *                           Can be set later via setNotifyCallback().
     */
    constructor(sendNotification?: () => void) {
        super();
        if (sendNotification) {
            this.setNotifyCallback(sendNotification);
        }
    }

    /**
     * Registers a new resource template.
     *
     * @param config - The template configuration
     * @returns The registered template
     * @throws If a template with the same name already exists
     */
    register(config: ResourceTemplateConfig): RegisteredResourceTemplateEntity {
        if (this._items.has(config.name)) {
            throw new Error(`Resource template '${config.name}' is already registered`);
        }

        const template = new RegisteredResourceTemplateEntity(config, this);
        this._set(config.name, template);
        this.notifyChanged();
        return template;
    }

    /**
     * Gets the list of enabled templates in protocol format.
     *
     * @returns Array of ResourceTemplate objects for the protocol response
     */
    getProtocolResourceTemplates(): ResourceTemplateProtocol[] {
        return this.getEnabled().map(template => template.toProtocolResourceTemplate());
    }

    /**
     * Gets a template by name.
     *
     * @param name - The template name
     * @returns The registered template or undefined
     */
    getTemplate(name: string): RegisteredResourceTemplateEntity | undefined {
        return this.get(name);
    }

    /**
     * Finds a template that matches the given URI.
     *
     * @param uri - The URI to match against templates
     * @returns The matching template and extracted variables, or undefined
     */
    findMatchingTemplate(uri: string): { template: RegisteredResourceTemplateEntity; variables: Variables } | undefined {
        for (const template of this.getEnabled()) {
            const variables = template.template.uriTemplate.match(uri);
            if (variables) {
                return { template, variables };
            }
        }
        return undefined;
    }
}
