import type {
    AnySchema,
    CallToolResult,
    Icon,
    RequestHandlerExtra,
    Result,
    SchemaOutput,
    ServerNotification,
    ServerRequest,
    ShapeOutput,
    Tool,
    ToolAnnotations,
    ToolExecution,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';
import { normalizeObjectSchema, toJsonSchemaCompat, validateAndWarnToolName } from '@modelcontextprotocol/core';

import type { ToolTaskHandler } from '../../experimental/tasks/interfaces.js';
import type { OnRemove, OnRename, OnUpdate } from './types.js';

/**
 * Base callback type for tool handlers.
 */
export type BaseToolCallback<
    SendResultT extends Result,
    Extra extends RequestHandlerExtra<ServerRequest, ServerNotification>,
    Args extends undefined | ZodRawShapeCompat | AnySchema
> = Args extends ZodRawShapeCompat
    ? (args: ShapeOutput<Args>, extra: Extra) => SendResultT | Promise<SendResultT>
    : Args extends AnySchema
      ? (args: SchemaOutput<Args>, extra: Extra) => SendResultT | Promise<SendResultT>
      : (extra: Extra) => SendResultT | Promise<SendResultT>;

/**
 * Callback for a tool handler registered with McpServer.registerTool().
 *
 * Parameters will include tool arguments, if applicable, as well as other request handler context.
 *
 * The callback should return:
 * - `structuredContent` if the tool has an outputSchema defined
 * - `content` if the tool does not have an outputSchema
 * - Both fields are optional but typically one should be provided
 */
export type ToolCallback<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> = BaseToolCallback<
    CallToolResult,
    RequestHandlerExtra<ServerRequest, ServerNotification>,
    Args
>;

/**
 * Supertype that can handle both regular tools (simple callback) and task-based tools (task handler object).
 */
export type AnyToolHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;

/**
 * Protocol fields for Tool, derived from the Tool type.
 * Uses Zod schemas instead of JSON Schema (converted in toProtocolTool).
 */
export type ToolProtocolFields = Omit<Tool, 'inputSchema' | 'outputSchema'> & {
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
};

/**
 * Configuration for creating a RegisteredTool.
 * Combines protocol fields with SDK-specific handler.
 */
export type ToolConfig = ToolProtocolFields & {
    handler: AnyToolHandler<undefined | ZodRawShapeCompat>;
};

const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object' as const,
    properties: {}
};

/**
 * A registered tool in the MCP server.
 * Provides methods to enable, disable, update, rename, and remove the tool.
 */
export class RegisteredTool {
    // Protocol fields - stored together for easy spreading
    #protocolFields: ToolProtocolFields;

    // SDK-specific fields - separate from protocol
    #handler: AnyToolHandler<undefined | ZodRawShapeCompat>;
    #enabled: boolean = true;

    // Callbacks for McpServer communication
    readonly #onUpdate: OnUpdate;
    readonly #onRename: OnRename<RegisteredTool>;
    readonly #onRemove: OnRemove;

    constructor(config: ToolConfig, onUpdate: OnUpdate, onRename: OnRename<RegisteredTool>, onRemove: OnRemove) {
        validateAndWarnToolName(config.name);

        // Separate protocol fields from SDK fields
        const { handler, ...protocolFields } = config;
        this.#protocolFields = protocolFields;
        this.#handler = handler;

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
    get inputSchema(): AnySchema | undefined {
        return this.#protocolFields.inputSchema;
    }
    get outputSchema(): AnySchema | undefined {
        return this.#protocolFields.outputSchema;
    }
    get annotations(): ToolAnnotations | undefined {
        return this.#protocolFields.annotations;
    }
    get execution(): ToolExecution | undefined {
        return this.#protocolFields.execution;
    }
    get _meta(): Record<string, unknown> | undefined {
        return this.#protocolFields._meta;
    }

    // SDK-specific getters
    get handler(): AnyToolHandler<undefined | ZodRawShapeCompat> {
        return this.#handler;
    }
    get enabled(): boolean {
        return this.#enabled;
    }

    /**
     * Enables the tool.
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
     * Disables the tool.
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
     * Renames the tool.
     * @param newName - The new name for the tool
     * @returns this for chaining
     */
    public rename(newName: string): this {
        if (newName !== this.#protocolFields.name) {
            validateAndWarnToolName(newName);
            const oldName = this.#protocolFields.name;
            this.#protocolFields.name = newName;
            this.#onRename(oldName, newName, this);
        }
        return this;
    }

    /**
     * Removes the tool from the registry.
     */
    public remove(): void {
        this.#onRemove(this.#protocolFields.name);
    }

    /**
     * Updates the tool's properties.
     * @param updates - The properties to update
     */
    public update(updates: Partial<ToolConfig> & { enabled?: boolean; name?: string | null }): void {
        const { name: nameUpdate, enabled: enabledUpdate, handler: handlerUpdate, ...protocolUpdates } = updates;
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

        // Update SDK-specific fields
        if (handlerUpdate !== undefined) this.#handler = handlerUpdate;

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
     * Converts to the Tool protocol type (for list responses).
     * Converts Zod schemas to JSON Schema format.
     */
    public toProtocolTool(): Tool {
        return {
            ...this.#protocolFields,
            // Override schemas with JSON Schema conversion
            inputSchema: (() => {
                const obj = normalizeObjectSchema(this.#protocolFields.inputSchema);
                return obj
                    ? (toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' }) as Tool['inputSchema'])
                    : EMPTY_OBJECT_JSON_SCHEMA;
            })(),
            outputSchema: this.#protocolFields.outputSchema
                ? (() => {
                      const obj = normalizeObjectSchema(this.#protocolFields.outputSchema);
                      return obj
                          ? (toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'output' }) as Tool['outputSchema'])
                          : undefined;
                  })()
                : undefined
        };
    }
}
