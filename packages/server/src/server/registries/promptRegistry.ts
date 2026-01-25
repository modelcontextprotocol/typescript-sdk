/**
 * Prompt Registry
 *
 * Manages registration and retrieval of prompts.
 * Provides class-based RegisteredPromptEntity entities with proper encapsulation.
 */

import type { AnyObjectSchema, AnySchema, Prompt, PromptArgument, ZodRawShapeCompat } from '@modelcontextprotocol/core';
import { getObjectShape, getSchemaDescription, isSchemaOptional, objectFromShape } from '@modelcontextprotocol/core';

import type { PromptCallback } from '../mcp.js';
import type { RegisteredDefinition } from './baseRegistry.js';
import { BaseRegistry } from './baseRegistry.js';

/**
 * Configuration for registering a prompt
 */
export interface PromptConfig {
    name: string;
    title?: string;
    description?: string;
    argsSchema?: ZodRawShapeCompat;
    callback: PromptCallback<ZodRawShapeCompat | undefined>;
}

/**
 * Updates that can be applied to a registered prompt
 */
export interface PromptUpdates {
    name?: string | null;
    title?: string;
    description?: string;
    argsSchema?: ZodRawShapeCompat;
    callback?: PromptCallback<ZodRawShapeCompat | undefined>;
    enabled?: boolean;
}

/**
 * Class-based representation of a registered prompt.
 * Provides methods for managing the prompt's lifecycle.
 */
export class RegisteredPromptEntity implements RegisteredDefinition {
    private _name: string;
    private _enabled: boolean = true;
    private readonly _registry: PromptRegistry;

    private _title?: string;
    private _description?: string;
    private _argsSchema?: AnyObjectSchema;
    private _callback: PromptCallback<ZodRawShapeCompat | undefined>;

    constructor(config: PromptConfig, registry: PromptRegistry) {
        this._name = config.name;
        this._registry = registry;
        this._title = config.title;
        this._description = config.description;
        this._argsSchema = config.argsSchema ? objectFromShape(config.argsSchema) : undefined;
        this._callback = config.callback;
    }

    /** The prompt's name (identifier) */
    get name(): string {
        return this._name;
    }

    /** Whether the prompt is currently enabled */
    get enabled(): boolean {
        return this._enabled;
    }

    /** The prompt's title */
    get title(): string | undefined {
        return this._title;
    }

    /** The prompt's description */
    get description(): string | undefined {
        return this._description;
    }

    /** The prompt's args schema */
    get argsSchema(): AnyObjectSchema | undefined {
        return this._argsSchema;
    }

    /** The prompt's callback */
    get callback(): PromptCallback<ZodRawShapeCompat | undefined> {
        return this._callback;
    }

    /**
     * Enables the prompt
     */
    enable(): this {
        if (!this._enabled) {
            this._enabled = true;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Disables the prompt
     */
    disable(): this {
        if (this._enabled) {
            this._enabled = false;
            this._registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Removes the prompt from its registry
     */
    remove(): void {
        this._registry.remove(this._name);
    }

    /**
     * Renames the prompt
     *
     * @param newName - The new name for the prompt
     */
    rename(newName: string): this {
        this._registry['_rename'](this._name, newName);
        this._name = newName;
        return this;
    }

    /**
     * Updates the prompt's properties
     *
     * @param updates - The updates to apply
     */
    update(updates: PromptUpdates): void {
        if (updates.name !== undefined) {
            if (updates.name === null) {
                this.remove();
                return;
            }
            this.rename(updates.name);
        }
        if (updates.title !== undefined) this._title = updates.title;
        if (updates.description !== undefined) this._description = updates.description;
        if (updates.argsSchema !== undefined) this._argsSchema = objectFromShape(updates.argsSchema);
        if (updates.callback !== undefined) this._callback = updates.callback;
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
     * Converts to the Prompt protocol type (for list responses)
     */
    toProtocolPrompt(): Prompt {
        return {
            name: this._name,
            title: this._title,
            description: this._description,
            arguments: this._argsSchema ? promptArgumentsFromSchema(this._argsSchema) : undefined
        };
    }
}

/**
 * Registry for managing prompts.
 */
export class PromptRegistry extends BaseRegistry<RegisteredPromptEntity> {
    /**
     * Creates a new PromptRegistry.
     *
     * @param sendNotification - Optional callback to invoke when the prompt list changes.
     *                           Can be set later via setNotifyCallback().
     */
    constructor(sendNotification?: () => void) {
        super();
        if (sendNotification) {
            this.setNotifyCallback(sendNotification);
        }
    }

    /**
     * Registers a new prompt.
     *
     * @param config - The prompt configuration
     * @returns The registered prompt
     * @throws If a prompt with the same name already exists
     */
    register(config: PromptConfig): RegisteredPromptEntity {
        if (this._items.has(config.name)) {
            throw new Error(`Prompt '${config.name}' is already registered`);
        }

        const prompt = new RegisteredPromptEntity(config, this);
        this._set(config.name, prompt);
        this.notifyChanged();
        return prompt;
    }

    /**
     * Gets the list of enabled prompts in protocol format.
     *
     * @returns Array of Prompt objects for the protocol response
     */
    getProtocolPrompts(): Prompt[] {
        return this.getEnabled().map(prompt => prompt.toProtocolPrompt());
    }

    /**
     * Gets a prompt by name.
     *
     * @param name - The prompt name
     * @returns The registered prompt or undefined
     */
    getPrompt(name: string): RegisteredPromptEntity | undefined {
        return this.get(name);
    }
}

/**
 * Converts a Zod object schema to an array of PromptArgument for the protocol.
 */
function promptArgumentsFromSchema(schema: AnyObjectSchema): PromptArgument[] {
    const shape = getObjectShape(schema);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]): PromptArgument => {
        const description = getSchemaDescription(field as AnySchema);
        const isOptional = isSchemaOptional(field as AnySchema);
        return {
            name,
            description,
            required: !isOptional
        };
    });
}
