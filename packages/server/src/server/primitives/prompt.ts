import type {
    AnyObjectSchema,
    GetPromptResult,
    Icon,
    Prompt,
    PromptArgument,
    RequestHandlerExtra,
    ServerNotification,
    ServerRequest,
    ShapeOutput,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';
import { getObjectShape, getSchemaDescription, isSchemaOptional, objectFromShape } from '@modelcontextprotocol/core';

import type { OnRemove, OnRename, OnUpdate } from './types.js';

/**
 * Raw shape type for prompt arguments (Zod schema shape).
 */
export type PromptArgsRawShape = ZodRawShapeCompat;

/**
 * Callback for a prompt handler registered with McpServer.registerPrompt().
 */
export type PromptCallback<Args extends undefined | PromptArgsRawShape = undefined> = Args extends PromptArgsRawShape
    ? (args: ShapeOutput<Args>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>
    : (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>;

/**
 * Protocol fields for Prompt, derived from the Prompt type.
 * Uses argsSchema (Zod shape) instead of arguments array (converted in toProtocolPrompt).
 */
export type PromptProtocolFields = Omit<Prompt, 'arguments'> & {
    argsSchema?: AnyObjectSchema;
};

/**
 * Configuration for creating a RegisteredPrompt.
 * Combines protocol fields with SDK-specific callback.
 */
export type PromptConfig = PromptProtocolFields & {
    callback: PromptCallback<undefined | PromptArgsRawShape>;
};

/**
 * Converts a Zod object schema to an array of PromptArguments.
 */
function promptArgumentsFromSchema(schema: AnyObjectSchema): PromptArgument[] {
    const shape = getObjectShape(schema);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]): PromptArgument => {
        const description = getSchemaDescription(field);
        const isOptional = isSchemaOptional(field);
        return {
            name,
            description,
            required: !isOptional
        };
    });
}

/**
 * A registered prompt in the MCP server.
 * Provides methods to enable, disable, update, rename, and remove the prompt.
 */
export class RegisteredPrompt {
    // Protocol fields - stored together for easy spreading
    #protocolFields: PromptProtocolFields;

    // SDK-specific fields - separate from protocol
    #callback: PromptCallback<undefined | PromptArgsRawShape>;
    #enabled: boolean = true;

    // Callbacks for McpServer communication
    readonly #onUpdate: OnUpdate;
    readonly #onRename: OnRename<RegisteredPrompt>;
    readonly #onRemove: OnRemove;

    constructor(config: PromptConfig, onUpdate: OnUpdate, onRename: OnRename<RegisteredPrompt>, onRemove: OnRemove) {
        // Separate protocol fields from SDK fields
        const { callback, ...protocolFields } = config;
        this.#protocolFields = protocolFields;
        this.#callback = callback;

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
    get icons(): Icon[] | undefined {
        return this.#protocolFields.icons;
    }
    get argsSchema(): AnyObjectSchema | undefined {
        return this.#protocolFields.argsSchema;
    }
    get _meta(): Record<string, unknown> | undefined {
        return this.#protocolFields._meta;
    }

    // SDK-specific getters
    get callback(): PromptCallback<undefined | PromptArgsRawShape> {
        return this.#callback;
    }
    get enabled(): boolean {
        return this.#enabled;
    }

    /**
     * Enables the prompt.
     * @returns this for chaining
     */
    enable(): this {
        if (!this.#enabled) {
            this.#enabled = true;
            this.#onUpdate();
        }
        return this;
    }

    /**
     * Disables the prompt.
     * @returns this for chaining
     */
    disable(): this {
        if (this.#enabled) {
            this.#enabled = false;
            this.#onUpdate();
        }
        return this;
    }

    /**
     * Renames the prompt.
     * @param newName - The new name for the prompt
     * @returns this for chaining
     */
    rename(newName: string): this {
        if (newName !== this.#protocolFields.name) {
            const oldName = this.#protocolFields.name;
            this.#protocolFields.name = newName;
            this.#onRename(oldName, newName, this);
        }
        return this;
    }

    /**
     * Removes the prompt from the registry.
     */
    remove(): void {
        this.#onRemove(this.#protocolFields.name);
    }

    /**
     * Updates the prompt's properties.
     * @param updates - The properties to update
     */
    update<Args extends PromptArgsRawShape>(
        updates: {
            name?: string | null;
            argsSchema?: Args;
            callback?: PromptCallback<Args>;
            enabled?: boolean;
        } & Omit<Partial<PromptProtocolFields>, 'name' | 'argsSchema'>
    ): void {
        // Handle name change (rename or remove)
        if (updates.name !== undefined) {
            if (updates.name === null) {
                this.remove();
                return;
            }
            this.rename(updates.name);
        }

        // Extract special fields, update protocol fields in one go
        const { name: _name, enabled, argsSchema, callback, ...protocolUpdates } = updates;
        void _name; // Already handled above
        Object.assign(this.#protocolFields, protocolUpdates);

        // Convert argsSchema from raw shape to object schema if provided
        if (argsSchema !== undefined) {
            this.#protocolFields.argsSchema = objectFromShape(argsSchema);
        }

        // Update SDK-specific fields
        if (callback !== undefined) {
            this.#callback = callback as PromptCallback<undefined | PromptArgsRawShape>;
        }

        // Handle enabled (triggers its own notification)
        if (enabled === undefined) {
            this.#onUpdate();
        } else if (enabled) {
            this.enable();
        } else {
            this.disable();
        }
    }

    /**
     * Converts to the Prompt protocol type (for list responses).
     * Converts argsSchema to arguments array.
     */
    toProtocolPrompt(): Prompt {
        return {
            ...this.#protocolFields,
            // Convert argsSchema to arguments array
            arguments: this.#protocolFields.argsSchema ? promptArgumentsFromSchema(this.#protocolFields.argsSchema) : undefined,
            // Remove argsSchema from output (it's SDK-specific)
            argsSchema: undefined
        } as Prompt;
    }
}
