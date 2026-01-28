/**
 * Tool Registry
 *
 * Manages registration and retrieval of tools.
 * Provides class-based RegisteredTool entities with proper encapsulation.
 */

import type { AnySchema, Tool, ToolAnnotations, ToolExecution, ZodRawShapeCompat } from '@modelcontextprotocol/core';
import { normalizeObjectSchema, toJsonSchemaCompat, validateAndWarnToolName } from '@modelcontextprotocol/core';

import type { RegisteredToolInterface } from '../../types/types.js';
import type { AnyToolHandler } from '../mcp.js';
import { BaseRegistry } from './baseRegistry.js';

/**
 * Configuration for registering a tool
 */
export interface ToolConfig {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler: AnyToolHandler<undefined | ZodRawShapeCompat>;
}

/**
 * Updates that can be applied to a registered tool
 */
export interface ToolUpdates {
    name?: string | null;
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler?: AnyToolHandler<undefined | ZodRawShapeCompat>;
    enabled?: boolean;
}

const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {}
};

/**
 * Class-based representation of a registered tool.
 * Provides methods for managing the tool's lifecycle.
 */
export class RegisteredTool implements RegisteredToolInterface {
    #name: string;
    #enabled: boolean = true;
    readonly #registry: ToolRegistry;

    #title?: string;
    #description?: string;
    #inputSchema?: AnySchema;
    #outputSchema?: AnySchema;
    #annotations?: ToolAnnotations;
    #execution?: ToolExecution;
    #__meta?: Record<string, unknown>;
    #handler: AnyToolHandler<undefined | ZodRawShapeCompat>;

    constructor(config: ToolConfig, registry: ToolRegistry) {
        this.#name = config.name;
        this.#registry = registry;
        this.#title = config.title;
        this.#description = config.description;
        this.#inputSchema = config.inputSchema;
        this.#outputSchema = config.outputSchema;
        this.#annotations = config.annotations;
        this.#execution = config.execution;
        this.#__meta = config._meta;
        this.#handler = config.handler;
    }

    /** The tool's name (identifier) */
    get name(): string {
        return this.#name;
    }

    /** Whether the tool is currently enabled */
    get enabled(): boolean {
        return this.#enabled;
    }

    /** The tool's title */
    get title(): string | undefined {
        return this.#title;
    }

    /** The tool's description */
    get description(): string | undefined {
        return this.#description;
    }

    /** The tool's input schema */
    get inputSchema(): AnySchema | undefined {
        return this.#inputSchema;
    }

    /** The tool's output schema */
    get outputSchema(): AnySchema | undefined {
        return this.#outputSchema;
    }

    /** The tool's annotations */
    get annotations(): ToolAnnotations | undefined {
        return this.#annotations;
    }

    /** The tool's execution settings */
    get execution(): ToolExecution | undefined {
        return this.#execution;
    }

    /** The tool's metadata */
    get _meta(): Record<string, unknown> | undefined {
        return this.#__meta;
    }

    /** The tool's handler function */
    get handler(): AnyToolHandler<undefined | ZodRawShapeCompat> {
        return this.#handler;
    }

    /**
     * Enables the tool
     */
    enable(): this {
        if (!this.#enabled) {
            this.#enabled = true;
            this.#registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Disables the tool
     */
    disable(): this {
        if (this.#enabled) {
            this.#enabled = false;
            this.#registry['notifyChanged']();
        }
        return this;
    }

    /**
     * Removes the tool from its registry
     */
    remove(): void {
        this.#registry.remove(this.#name);
    }

    /**
     * Renames the tool
     *
     * @param newName - The new name for the tool
     */
    rename(newName: string): this {
        validateAndWarnToolName(newName);
        this.#registry['_rename'](this.#name, newName);
        this.#name = newName;
        return this;
    }

    /**
     * Updates the tool's properties
     *
     * @param updates - The updates to apply
     */
    update<InputArgs extends AnySchema, OutputArgs extends AnySchema>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
        handler?: AnyToolHandler<undefined | ZodRawShapeCompat>;
        execution?: ToolExecution;
        enabled?: boolean;
    }): void {
        if (updates.name !== undefined) {
            if (updates.name === null) {
                this.remove();
                return;
            }
            this.rename(updates.name);
        }
        if (updates.title !== undefined) this.#title = updates.title;
        if (updates.description !== undefined) this.#description = updates.description;
        if (updates.inputSchema !== undefined) this.#inputSchema = updates.inputSchema;
        if (updates.outputSchema !== undefined) this.#outputSchema = updates.outputSchema;
        if (updates.annotations !== undefined) this.#annotations = updates.annotations;
        if (updates.execution !== undefined) this.#execution = updates.execution;
        if (updates._meta !== undefined) this.#__meta = updates._meta;
        if (updates.handler !== undefined) this.#handler = updates.handler;
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
     * Converts to the Tool protocol type (for list responses)
     */
    toProtocolTool(): Tool {
        const tool: Tool = {
            name: this.#name,
            title: this.#title,
            description: this.#description,
            inputSchema: this.#inputSchema
                ? (toJsonSchemaCompat(normalizeObjectSchema(this.#inputSchema) ?? this.#inputSchema, {
                      strictUnions: true,
                      pipeStrategy: 'input'
                  }) as Tool['inputSchema'])
                : EMPTY_OBJECT_JSON_SCHEMA,
            annotations: this.#annotations,
            execution: this.#execution,
            _meta: this.#__meta
        };

        if (this.#outputSchema) {
            const obj = normalizeObjectSchema(this.#outputSchema);
            if (obj) {
                tool.outputSchema = toJsonSchemaCompat(obj, {
                    strictUnions: true,
                    pipeStrategy: 'output'
                }) as Tool['outputSchema'];
            }
        }

        return tool;
    }
}

/**
 * Registry for managing tools.
 */
export class ToolRegistry extends BaseRegistry<RegisteredTool> {
    /**
     * Creates a new ToolRegistry.
     *
     * @param sendNotification - Optional callback to invoke when the tool list changes.
     *                           Can be set later via setNotifyCallback().
     */
    constructor(sendNotification?: () => void) {
        super();
        if (sendNotification) {
            this.setNotifyCallback(sendNotification);
        }
    }

    /**
     * Registers a new tool.
     *
     * @param config - The tool configuration
     * @returns The registered tool
     * @throws If a tool with the same name already exists
     */
    register(config: ToolConfig): RegisteredTool {
        if (this._items.has(config.name)) {
            throw new Error(`Tool '${config.name}' is already registered`);
        }

        validateAndWarnToolName(config.name);
        const tool = new RegisteredTool(config, this);
        this._set(config.name, tool);
        this.notifyChanged();
        return tool;
    }

    /**
     * Gets the list of enabled tools in protocol format.
     *
     * @returns Array of Tool objects for the protocol response
     */
    getProtocolTools(): Tool[] {
        return this.getEnabled().map(tool => tool.toProtocolTool());
    }

    /**
     * Gets a tool by name.
     *
     * @param name - The tool name
     * @returns The registered tool or undefined
     */
    getTool(name: string): RegisteredTool | undefined {
        return this.get(name);
    }
}
