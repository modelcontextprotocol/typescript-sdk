/**
 * Prompt Registry
 *
 * Manages registration and retrieval of prompts.
 * Provides class-based RegisteredPromptEntity entities with proper encapsulation.
 */

import type { AnyObjectSchema, AnySchema, Prompt, PromptArgument, ZodRawShapeCompat } from '@modelcontextprotocol/core';
import { getObjectShape, getSchemaDescription, isSchemaOptional, objectFromShape } from '@modelcontextprotocol/core';

import type { PromptCallback, RegisteredPromptInterface } from '../../types/types.js';
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
export class RegisteredPrompt implements RegisteredPromptInterface {
    #name: string;
    #enabled: boolean = true;
    readonly #registry: PromptRegistry;

    #title?: string;
    #description?: string;
    #argsSchema?: AnyObjectSchema;
    #callback: PromptCallback<ZodRawShapeCompat | undefined>;

    constructor(config: PromptConfig, registry: PromptRegistry) {
        this.#name = config.name;
        this.#registry = registry;
        this.#title = config.title;
        this.#description = config.description;
        this.#argsSchema = config.argsSchema ? objectFromShape(config.argsSchema) : undefined;
        this.#callback = config.callback;
    }

    /** The prompt's name (identifier) */
    get name(): string {
        return this.#name;
    }

    /** Whether the prompt is currently enabled */
    get enabled(): boolean {
        return this.#enabled;
    }

    /** The prompt's title */
    get title(): string | undefined {
        return this.#title;
    }

    /** The prompt's description */
    get description(): string | undefined {
        return this.#description;
    }

    /** The prompt's args schema */
    get argsSchema(): AnyObjectSchema | undefined {
        return this.#argsSchema;
    }

    /** The prompt's callback */
    get callback(): PromptCallback<ZodRawShapeCompat | undefined> {
        return this.#callback;
    }

    /**
     * Enables the prompt
     */
    enable(): this {
        if (!this.#enabled) {
            this.#enabled = true;
            this.#registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Disables the prompt
     */
    disable(): this {
        if (this.#enabled) {
            this.#enabled = false;
            this.#registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Removes the prompt from its registry
     */
    remove(): void {
        this.#registry.remove(this.#name);
    }

    /**
     * Renames the prompt
     *
     * @param newName - The new name for the prompt
     */
    rename(newName: string): this {
        this.#registry['_rename'](this.#name, newName);
        this.#name = newName;
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
        if (updates.title !== undefined) this.#title = updates.title;
        if (updates.description !== undefined) this.#description = updates.description;
        if (updates.argsSchema !== undefined) this.#argsSchema = objectFromShape(updates.argsSchema);
        if (updates.callback !== undefined) this.#callback = updates.callback;
        if (updates.enabled === undefined) {
            this.#registry['notifyChanged']();
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
            name: this.#name,
            title: this.#title,
            description: this.#description,
            arguments: this.#argsSchema ? promptArgumentsFromSchema(this.#argsSchema) : undefined
        };
    }
}

/**
 * Registry for managing prompts.
 */
export class PromptRegistry extends BaseRegistry<RegisteredPrompt> {
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
    register(config: PromptConfig): RegisteredPrompt {
        if (this._items.has(config.name)) {
            throw new Error(`Prompt '${config.name}' is already registered`);
        }

        const prompt = new RegisteredPrompt(config, this);
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
    getPrompt(name: string): RegisteredPrompt | undefined {
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
