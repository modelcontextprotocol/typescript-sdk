import type { AnySchema, GetPromptResult, Icon, Prompt, PromptArgument, SchemaOutput, ServerContext } from '@modelcontextprotocol/core';
import {
    getSchemaDescription,
    getSchemaShape,
    isOptionalSchema,
    parseSchemaAsync,
    ProtocolError,
    ProtocolErrorCode
} from '@modelcontextprotocol/core';

import type { OnRemove, OnRename, OnUpdate } from './types.js';

/**
 * Raw shape type for prompt arguments (Zod schema shape).
 */
export type PromptArgsRawShape = AnySchema;

/**
 * Callback for a prompt handler registered with McpServer.registerPrompt().
 */
export type PromptCallback<Args extends AnySchema | undefined = undefined> = Args extends AnySchema
    ? (args: SchemaOutput<Args>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>
    : (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;

/**
 * Protocol fields for Prompt, derived from the Prompt type.
 * Uses argsSchema (Zod schema) instead of arguments array (converted in toProtocolPrompt).
 */
export type PromptProtocolFields = Omit<Prompt, 'arguments'> & {
    argsSchema?: AnySchema;
};

/**
 * Configuration for creating a RegisteredPrompt.
 * Combines protocol fields with SDK-specific callback.
 */
export type PromptConfig = PromptProtocolFields & {
    callback: PromptCallback<AnySchema | undefined>;
};

/**
 * Converts a Zod object schema to an array of PromptArguments.
 */
function promptArgumentsFromSchema(schema: AnySchema): PromptArgument[] {
    const shape = getSchemaShape(schema);
    if (!shape) return [];
    return Object.entries(shape).map(([name, field]): PromptArgument => {
        const description = getSchemaDescription(field);
        const isOptional = isOptionalSchema(field);
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
    #callback: PromptCallback<AnySchema | undefined>;
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
    get argsSchema(): AnySchema | undefined {
        return this.#protocolFields.argsSchema;
    }
    get _meta(): Record<string, unknown> | undefined {
        return this.#protocolFields._meta;
    }

    // SDK-specific getters
    get callback(): PromptCallback<AnySchema | undefined> {
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
    update<Args extends AnySchema>(
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

        // Update argsSchema if provided
        if (argsSchema !== undefined) {
            this.#protocolFields.argsSchema = argsSchema;
        }

        // Update SDK-specific fields
        if (callback !== undefined) {
            this.#callback = callback as PromptCallback<AnySchema | undefined>;
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
     * Executes the prompt handler with the given arguments and context.
     * Handles schema validation when argsSchema is defined.
     */
    public async handler(args: Record<string, unknown> | undefined, ctx: ServerContext): Promise<GetPromptResult> {
        if (this.#protocolFields.argsSchema) {
            const typedCallback = this.#callback as (
                args: SchemaOutput<AnySchema>,
                ctx: ServerContext
            ) => GetPromptResult | Promise<GetPromptResult>;
            const parseResult = await parseSchemaAsync(this.#protocolFields.argsSchema, args);
            if (!parseResult.success) {
                const errorMessage = parseResult.error.issues.map((i: { message: string }) => i.message).join(', ');
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Invalid arguments for prompt ${this.#protocolFields.name}: ${errorMessage}`
                );
            }
            return typedCallback(parseResult.data as SchemaOutput<AnySchema>, ctx);
        }

        const typedCallback = this.#callback as (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;
        return typedCallback(ctx);
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
