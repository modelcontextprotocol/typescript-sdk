import { Server, ServerOptions } from "./index.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  z,
  ZodRawShape,
  ZodObject,
  ZodString,
  AnyZodObject,
  ZodTypeAny,
  ZodType,
  ZodTypeDef,
  ZodOptional,
} from "zod";
import {
  Implementation,
  Tool,
  ListToolsResult,
  CallToolResult,
  McpError,
  ErrorCode,
  CompleteRequest,
  CompleteResult,
  PromptReference,
  ResourceReference,
  Resource,
  ListResourcesResult,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  ListPromptsResult,
  Prompt,
  PromptArgument,
  GetPromptResult,
  ReadResourceResult,
  ServerRequest,
  ServerNotification,
} from "../types.js";
import { Completable, CompletableDef } from "./completable.js";
import { UriTemplate, Variables } from "../shared/uriTemplate.js";
import { RequestHandlerExtra } from "../shared/protocol.js";
import { Transport } from "../shared/transport.js";
import { createEventNotifier } from "../shared/eventNotifier.js";

/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * Server instance available via the `server` property.
 */
export class McpServer {
  /**
   * The underlying Server instance, useful for advanced operations like sending notifications.
   */
  public readonly server: Server;

  private _registeredResources: { [uri: string]: RegisteredResource } = {};
  private _registeredResourceTemplates: {
    [name: string]: RegisteredResourceTemplate;
  } = {};
  private _registeredTools: { [name: string]: RegisteredTool } = {};
  private _registeredPrompts: { [name: string]: RegisteredPrompt } = {};

  private _onCapabilityChange = createEventNotifier<CapabilityEvent>();
  /** Counter for unique resource invocation indexes, used to correlate resource invocation events */
  private _resourceInvocationIndex = 0;
  /** Counter for unique tool invocation indexes, used to correlate tool invocation events */
  private _toolInvocationIndex = 0;
  /** Counter for unique prompt invocation indexes, used to correlate prompt invocation events */
  private _promptInvocationIndex = 0;

  constructor(serverInfo: Implementation, options?: ServerOptions) {
    this.server = new Server(serverInfo, options);
  }

  /**
   * Attaches to the given transport, starts it, and starts listening for messages.
   *
   * The `server` object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
   */
  async connect(transport: Transport): Promise<void> {
    return await this.server.connect(transport);
  }

  /**
   * Closes the connection.
   */
  async close(): Promise<void> {
    this._onCapabilityChange.close();
    await this.server.close();
  }

  /**
   * Event notifier for capability changes. Listeners will be notified when capabilities are added, updated, removed,
   * enabled, disabled, invoked, completed, or when errors occur.
   *
   * This provides a way to monitor and respond to all capability-related activities in the server,
   * including both lifecycle changes and invocation events. Each capability type (resource, tool, prompt)
   * maintains its own sequence of invocation indexes, which can be used to correlate invocations
   * with their completions or errors.
   *
   * @example
   * const subscription = server.onCapabilityChange((event) => {
   *   if (event.action === "invoked") {
   *     console.log(`${event.capabilityType} ${event.capabilityName} invoked with index ${event.invocationIndex}`);
   *   } else if (event.action === "completed" || event.action === "error") {
   *     console.log(`${event.capabilityType} operation completed in ${event.durationMs}ms`);
   *   }
   * });
   *
   * // Later, to stop listening:
   * subscription.close();
   */
  public readonly onCapabilityChange = this._onCapabilityChange.onEvent;

  private _toolHandlersInitialized = false;

  private setToolRequestHandlers() {
    if (this._toolHandlersInitialized) {
      return;
    }

    this.server.assertCanSetRequestHandler(
      ListToolsRequestSchema.shape.method.value,
    );
    this.server.assertCanSetRequestHandler(
      CallToolRequestSchema.shape.method.value,
    );

    this.server.registerCapabilities({
      tools: {
        listChanged: true
      }
    })

    this.server.setRequestHandler(
      ListToolsRequestSchema,
      (): ListToolsResult => ({
        tools: Object.entries(this._registeredTools).filter(
          ([, tool]) => tool.enabled,
        ).map(
          ([name, tool]): Tool => {
            return {
              name,
              description: tool.description,
              inputSchema: tool.inputSchema
                ? (zodToJsonSchema(tool.inputSchema, {
                    strictUnions: true,
                  }) as Tool["inputSchema"])
                : EMPTY_OBJECT_JSON_SCHEMA,
            };
          },
        ),
      }),
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        const tool = this._registeredTools[request.params.name];
        if (!tool) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Tool ${request.params.name} not found`,
          );
        }

        const invocationIndex = this._toolInvocationIndex++;
        const startTime = performance.now();

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "tool",
          capabilityName: request.params.name,
          action: "invoked",
          invocationIndex,
          arguments: request.params.arguments,
        }));

        if (!tool.enabled) {
          const error = new McpError(
            ErrorCode.InvalidParams,
            `Tool ${request.params.name} disabled`,
          );

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "tool",
            capabilityName: request.params.name,
            action: "error",
            invocationIndex,
            error,
            durationMs: performance.now() - startTime,
          }));

          throw error;
        }

        if (tool.inputSchema) {
          const parseResult = await tool.inputSchema.safeParseAsync(
            request.params.arguments,
          );
          if (!parseResult.success) {
            const error = new McpError(
              ErrorCode.InvalidParams,
              `Invalid arguments for tool ${request.params.name}: ${parseResult.error.message}`,
            );

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "tool",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }

          const args = parseResult.data;
          const cb = tool.callback as ToolCallback<ZodRawShape>;
          try {
            return await Promise.resolve(cb(args, extra)).then((result) => {
              this._onCapabilityChange.notify(() => ({
                serverInfo: this.server.getVersion(),
                capabilityType: "tool",
                capabilityName: request.params.name,
                action: "completed",
                invocationIndex,
                result,
                durationMs: performance.now() - startTime,
              }));

              return result;
            });
          } catch (error) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "tool",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            };
          }
        } else {
          const cb = tool.callback as ToolCallback<undefined>;
          try {
            const result = await Promise.resolve(cb(extra));

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "tool",
              capabilityName: request.params.name,
              action: "completed",
              invocationIndex,
              result,
              durationMs: performance.now() - startTime,
            }));

            return result;
          } catch (error) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "tool",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            };
          }
        }
      },
    );

    this._toolHandlersInitialized = true;
  }

  private _completionHandlerInitialized = false;

  private setCompletionRequestHandler() {
    if (this._completionHandlerInitialized) {
      return;
    }

    this.server.assertCanSetRequestHandler(
      CompleteRequestSchema.shape.method.value,
    );

    this.server.setRequestHandler(
      CompleteRequestSchema,
      async (request): Promise<CompleteResult> => {
        switch (request.params.ref.type) {
          case "ref/prompt":
            return this.handlePromptCompletion(request, request.params.ref);

          case "ref/resource":
            return this.handleResourceCompletion(request, request.params.ref);

          default:
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid completion reference: ${request.params.ref}`,
            );
        }
      },
    );

    this._completionHandlerInitialized = true;
  }

  private async handlePromptCompletion(
    request: CompleteRequest,
    ref: PromptReference,
  ): Promise<CompleteResult> {
    const prompt = this._registeredPrompts[ref.name];
    if (!prompt) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Prompt ${ref.name} not found`,
      );
    }

    const invocationIndex = this._promptInvocationIndex++;
    const startTime = performance.now();

    this._onCapabilityChange.notify(() => ({
      serverInfo: this.server.getVersion(),
      capabilityType: "prompt",
      capabilityName: ref.name,
      action: "invoked",
      invocationIndex,
      arguments: request.params.argument.name,
    }));

    if (!prompt.enabled) {
      const error = new McpError(
        ErrorCode.InvalidParams,
        `Prompt ${ref.name} disabled`,
      );

      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "prompt",
        capabilityName: ref.name,
        action: "error",
        invocationIndex,
        error,
        durationMs: performance.now() - startTime,
      }));

      throw error;
    }

    if (!prompt.argsSchema) {
      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "prompt",
        capabilityName: ref.name,
        action: "completed",
        invocationIndex,
        result: EMPTY_COMPLETION_RESULT,
        durationMs: performance.now() - startTime,
      }));

      return EMPTY_COMPLETION_RESULT;
    }

    const field = prompt.argsSchema.shape[request.params.argument.name];
    if (!(field instanceof Completable)) {
      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "prompt",
        capabilityName: ref.name,
        action: "completed",
        invocationIndex,
        result: EMPTY_COMPLETION_RESULT,
        durationMs: performance.now() - startTime,
      }));

      return EMPTY_COMPLETION_RESULT;
    }

    const def: CompletableDef<ZodString> = field._def;
    const suggestions = await def.complete(request.params.argument.value);

    this._onCapabilityChange.notify(() => ({
      serverInfo: this.server.getVersion(),
      capabilityType: "prompt",
      capabilityName: ref.name,
      action: "completed",
      invocationIndex,
      result: suggestions,
      durationMs: performance.now() - startTime,
    }));

    return createCompletionResult(suggestions);
  }

  private async handleResourceCompletion(
    request: CompleteRequest,
    ref: ResourceReference,
  ): Promise<CompleteResult> {
    const template = Object.values(this._registeredResourceTemplates).find(
      (t) => t.resourceTemplate.uriTemplate.toString() === ref.uri,
    );

    const invocationIndex = this._resourceInvocationIndex++;
    const startTime = performance.now();

    if (!template) {
      if (this._registeredResources[ref.uri]) {
        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "resource",
          capabilityName: ref.uri,
          action: "completed",
          invocationIndex,
          result: EMPTY_COMPLETION_RESULT,
          durationMs: performance.now() - startTime,
        }));

        // Attempting to autocomplete a fixed resource URI is not an error in the spec (but probably should be).
        return EMPTY_COMPLETION_RESULT;
      }

      throw new McpError(
        ErrorCode.InvalidParams,
        `Resource template ${request.params.ref.uri} not found`,
      );
    }

    const completer = template.resourceTemplate.completeCallback(
      request.params.argument.name,
    );
    if (!completer) {
      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "resource",
        capabilityName: ref.uri,
        action: "completed",
        invocationIndex,
        result: EMPTY_COMPLETION_RESULT,
        durationMs: performance.now() - startTime,
      }));

      return EMPTY_COMPLETION_RESULT;
    }

    try {
      const suggestions = await completer(request.params.argument.value);

      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "resource",
        capabilityName: ref.uri,
        action: "completed",
        invocationIndex,
        result: suggestions,
        durationMs: performance.now() - startTime,
      }));

      return createCompletionResult(suggestions);
    } catch (error) {
      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "resource",
        capabilityName: ref.uri,
        action: "error",
        invocationIndex,
        error,
        durationMs: performance.now() - startTime,
      }));

      throw error;
    }
  }

  private _resourceHandlersInitialized = false;

  private setResourceRequestHandlers() {
    if (this._resourceHandlersInitialized) {
      return;
    }

    this.server.assertCanSetRequestHandler(
      ListResourcesRequestSchema.shape.method.value,
    );
    this.server.assertCanSetRequestHandler(
      ListResourceTemplatesRequestSchema.shape.method.value,
    );
    this.server.assertCanSetRequestHandler(
      ReadResourceRequestSchema.shape.method.value,
    );

    this.server.registerCapabilities({
      resources: {
        listChanged: true
      }
    })

    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request, extra) => {
        const resources = Object.entries(this._registeredResources).filter(
          ([_, resource]) => resource.enabled,
        ).map(
          ([uri, resource]) => ({
            uri,
            name: resource.name,
            ...resource.metadata,
          }),
        );

        const templateResources: Resource[] = [];
        for (const template of Object.values(
          this._registeredResourceTemplates,
        )) {
          if (!template.resourceTemplate.listCallback) {
            continue;
          }

          const result = await template.resourceTemplate.listCallback(extra);
          for (const resource of result.resources) {
            templateResources.push({
              ...resource,
              ...template.metadata,
            });
          }
        }

        return { resources: [...resources, ...templateResources] };
      },
    );

    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => {
        const resourceTemplates = Object.entries(
          this._registeredResourceTemplates,
        ).map(([name, template]) => ({
          name,
          uriTemplate: template.resourceTemplate.uriTemplate.toString(),
          ...template.metadata,
        }));

        return { resourceTemplates };
      },
    );

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request, extra) => {
        const uri = new URL(request.params.uri);

        // First check for exact resource match
        const resource = this._registeredResources[uri.toString()];
        if (resource) {
          const invocationIndex = this._resourceInvocationIndex++;
          const startTime = performance.now();

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: uri.toString(),
            action: "invoked",
            invocationIndex,
          }));

          if (!resource.enabled) {
            const error = new McpError(
              ErrorCode.InvalidParams,
              `Resource ${uri} disabled`,
            );

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: uri.toString(),
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }
          try {
            const result = await resource.readCallback(uri, extra);

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: uri.toString(),
              action: "completed",
              invocationIndex,
              result,
              durationMs: performance.now() - startTime,
            }));

            return result;
          } catch (error) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: uri.toString(),
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }
        }

        // Then check templates
        for (const template of Object.values(
          this._registeredResourceTemplates,
        )) {
          const variables = template.resourceTemplate.uriTemplate.match(
            uri.toString(),
          );
          if (variables) {
            const invocationIndex = this._resourceInvocationIndex++;
            const startTime = performance.now();

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: uri.toString(),
              action: "invoked",
              invocationIndex,
            }));

            try {
              const result = await template.readCallback(uri, variables, extra);

              this._onCapabilityChange.notify(() => ({
                serverInfo: this.server.getVersion(),
                capabilityType: "resource",
                capabilityName: uri.toString(),
                action: "completed",
                invocationIndex,
                result,
                durationMs: performance.now() - startTime,
              }));

              return result;
            } catch (error) {
              this._onCapabilityChange.notify(() => ({
                serverInfo: this.server.getVersion(),
                capabilityType: "resource",
                capabilityName: uri.toString(),
                action: "error",
                invocationIndex,
                error,
                durationMs: performance.now() - startTime,
              }));

              throw error;
            }
          }
        }

        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource ${uri} not found`,
        );
      },
    );

    this.setCompletionRequestHandler();

    this._resourceHandlersInitialized = true;
  }

  private _promptHandlersInitialized = false;

  private setPromptRequestHandlers() {
    if (this._promptHandlersInitialized) {
      return;
    }

    this.server.assertCanSetRequestHandler(
      ListPromptsRequestSchema.shape.method.value,
    );
    this.server.assertCanSetRequestHandler(
      GetPromptRequestSchema.shape.method.value,
    );

    this.server.registerCapabilities({
      prompts: {
        listChanged: true
      }
    })

    this.server.setRequestHandler(
      ListPromptsRequestSchema,
      (): ListPromptsResult => ({
        prompts: Object.entries(this._registeredPrompts).filter(
          ([, prompt]) => prompt.enabled,
        ).map(
          ([name, prompt]): Prompt => {
            return {
              name,
              description: prompt.description,
              arguments: prompt.argsSchema
                ? promptArgumentsFromSchema(prompt.argsSchema)
                : undefined,
            };
          },
        ),
      }),
    );

    this.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra): Promise<GetPromptResult> => {
        const prompt = this._registeredPrompts[request.params.name];
        if (!prompt) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Prompt ${request.params.name} not found`,
          );
        }

        const invocationIndex = this._promptInvocationIndex++;
        const startTime = performance.now();

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "prompt",
          capabilityName: request.params.name,
          action: "invoked",
          invocationIndex,
          arguments: request.params.arguments,
        }));

        if (!prompt.enabled) {
          const error = new McpError(
            ErrorCode.InvalidParams,
            `Prompt ${request.params.name} disabled`,
          );

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "prompt",
            capabilityName: request.params.name,
            action: "error",
            invocationIndex,
            error,
            durationMs: performance.now() - startTime,
          }));

          throw error;
        }

        if (prompt.argsSchema) {
          const parseResult = await prompt.argsSchema.safeParseAsync(
            request.params.arguments,
          );
          if (!parseResult.success) {
            const error = new McpError(
              ErrorCode.InvalidParams,
              `Invalid arguments for prompt ${request.params.name}: ${parseResult.error.message}`,
            );

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "prompt",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }

          const args = parseResult.data;
          const cb = prompt.callback as PromptCallback<PromptArgsRawShape>;

          try {
            const result = await Promise.resolve(cb(args, extra));

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "prompt",
              capabilityName: request.params.name,
              action: "completed",
              invocationIndex,
              result,
              durationMs: performance.now() - startTime,
            }));

            return result;
          } catch (error) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "prompt",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }
        } else {
          const cb = prompt.callback as PromptCallback<undefined>;

          try {
            const result = await Promise.resolve(cb(extra));

            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "prompt",
              capabilityName: request.params.name,
              action: "completed",
              invocationIndex,
              result,
              durationMs: performance.now() - startTime,
            }));

            return result;
          } catch (error) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "prompt",
              capabilityName: request.params.name,
              action: "error",
              invocationIndex,
              error,
              durationMs: performance.now() - startTime,
            }));

            throw error;
          }
        }
      }
    );

    this.setCompletionRequestHandler();

    this._promptHandlersInitialized = true;
  }

  /**
   * Registers a resource `name` at a fixed URI, which will use the given callback to respond to read requests.
   */
  resource(name: string, uri: string, readCallback: ReadResourceCallback): RegisteredResource;

  /**
   * Registers a resource `name` at a fixed URI with metadata, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): RegisteredResource;

  /**
   * Registers a resource `name` with a template pattern, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    template: ResourceTemplate,
    readCallback: ReadResourceTemplateCallback,
  ): RegisteredResourceTemplate;

  /**
   * Registers a resource `name` with a template pattern and metadata, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    template: ResourceTemplate,
    metadata: ResourceMetadata,
    readCallback: ReadResourceTemplateCallback,
  ): RegisteredResourceTemplate;

  resource(
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    ...rest: unknown[]
  ): RegisteredResource | RegisteredResourceTemplate {
    let metadata: ResourceMetadata | undefined;
    if (typeof rest[0] === "object") {
      metadata = rest.shift() as ResourceMetadata;
    }

    const readCallback = rest[0] as
      | ReadResourceCallback
      | ReadResourceTemplateCallback;

    if (typeof uriOrTemplate === "string") {
      if (this._registeredResources[uriOrTemplate]) {
        throw new Error(`Resource ${uriOrTemplate} is already registered`);
      }

      const registeredResource: RegisteredResource = {
        name,
        metadata,
        readCallback: readCallback as ReadResourceCallback,
        enabled: true,
        disable: () => {
          if (!registeredResource.enabled) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "disabled",
          }));

          registeredResource.update({ enabled: false });
        },
        enable: () => {
          if (registeredResource.enabled) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "enabled",
          }));

          registeredResource.update({ enabled: true });
        },
        remove: () => {
          if (uriOrTemplate === null) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "removed",
          }));

          registeredResource.update({ uri: null });
        },
        update: (updates) => {
          let added = false;
          let removed = false;
          let updated = false;
          let enabled = false;

          if (
            typeof updates.uri !== "undefined" &&
            updates.uri !== uriOrTemplate
          ) {
            removed = true;
            delete this._registeredResources[uriOrTemplate];

            if (updates.uri) {
              added = true;
              this._registeredResources[updates.uri] = registeredResource;
            }
          }

          if (typeof updates.name !== "undefined" && updates.name !== name) {
            updated = true;
            registeredResource.name = updates.name;
          }

          if (typeof updates.metadata !== "undefined" && updates.metadata !== metadata) {
            updated = true;
            registeredResource.metadata = updates.metadata;
          }

          if (typeof updates.callback !== "undefined" && updates.callback !== registeredResource.readCallback) {
            updated = true;
            registeredResource.readCallback = updates.callback;
          }

          if (typeof updates.enabled !== "undefined" && updates.enabled !== registeredResource.enabled) {
            enabled = true;
            registeredResource.enabled = updates.enabled;
          }

          if (removed) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: name,
              action: "removed",
            }));
          }

          if (added) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: registeredResource.name,
              action: "added",
            }));
          }

          if (updated) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: registeredResource.name,
              action: "updated",
            }));
          }

          if (enabled) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: registeredResource.name,
              action: registeredResource.enabled ? "enabled" : "disabled",
            }));
          }
          this.sendResourceListChanged();
        },
      };
      this._registeredResources[uriOrTemplate] = registeredResource;

      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "resource",
        capabilityName: name,
        action: "added",
      }));

      this.setResourceRequestHandlers();
      this.sendResourceListChanged();
      return registeredResource;
    } else {
      if (this._registeredResourceTemplates[name]) {
        throw new Error(`Resource template ${name} is already registered`);
      }

      const registeredResourceTemplate: RegisteredResourceTemplate = {
        resourceTemplate: uriOrTemplate,
        metadata,
        readCallback: readCallback as ReadResourceTemplateCallback,
        enabled: true,
        disable: () => {
          if (!registeredResourceTemplate.enabled) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "disabled",
          }));

          registeredResourceTemplate.update({ enabled: false });
        },
        enable: () => {
          if (registeredResourceTemplate.enabled) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "enabled",
          }));

          registeredResourceTemplate.update({ enabled: true });
        },
        remove: () => {
          if (name === null) return;

          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "resource",
            capabilityName: name,
            action: "removed",
          }));

          registeredResourceTemplate.update({ name: null });
        },
        update: (updates) => {
          let added = false;
          let removed = false;
          let updated = false;
          let enabled = false;

          if (typeof updates.name !== "undefined" && updates.name !== name) {
            removed = true;
            delete this._registeredResourceTemplates[name];

            if (updates.name) {
              added = true;
              this._registeredResourceTemplates[updates.name] =
                registeredResourceTemplate;
            }
          }

          if (typeof updates.template !== "undefined" && updates.template !== registeredResourceTemplate.resourceTemplate) {
            updated = true;
            registeredResourceTemplate.resourceTemplate = updates.template;
          }

          if (
            typeof updates.metadata !== "undefined" &&
            updates.metadata !== metadata
          ) {
            updated = true;
            registeredResourceTemplate.metadata = updates.metadata;
          }

          if (
            typeof updates.callback !== "undefined" &&
            updates.callback !== registeredResourceTemplate.readCallback
          ) {
            updated = true;
            registeredResourceTemplate.readCallback = updates.callback;
          }

          if (
            typeof updates.enabled !== "undefined" &&
            updates.enabled !== registeredResourceTemplate.enabled
          ) {
          enabled = true;
            registeredResourceTemplate.enabled = updates.enabled;
          }

          if (removed) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: name,
              action: "removed",
            }));
          }

          if (added) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: updates.name || name,
              action: "added",
            }));
          }

          if (updated) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: updates.name || name,
              action: "updated",
            }));
          }

          if (enabled) {
            this._onCapabilityChange.notify(() => ({
              serverInfo: this.server.getVersion(),
              capabilityType: "resource",
              capabilityName: updates.name || name,
              action: registeredResourceTemplate.enabled ? "enabled" : "disabled",
            }));
          }

          this.sendResourceListChanged();
        },
      };
      this._registeredResourceTemplates[name] = registeredResourceTemplate;

      this._onCapabilityChange.notify(() => ({
        serverInfo: this.server.getVersion(),
        capabilityType: "resource",
        capabilityName: name,
        action: "added",
      }));

      this.setResourceRequestHandlers();
      this.sendResourceListChanged();
      return registeredResourceTemplate;
    }
  }

  /**
   * Registers a zero-argument tool `name`, which will run the given function when the client calls it.
   */
  tool(name: string, cb: ToolCallback): RegisteredTool;

  /**
   * Registers a zero-argument tool `name` (with a description) which will run the given function when the client calls it.
   */
  tool(name: string, description: string, cb: ToolCallback): RegisteredTool;

  /**
   * Registers a tool `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): RegisteredTool;

  /**
   * Registers a tool `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): RegisteredTool;

  tool(name: string, ...rest: unknown[]): RegisteredTool {
    if (this._registeredTools[name]) {
      throw new Error(`Tool ${name} is already registered`);
    }

    let description: string | undefined;
    if (typeof rest[0] === "string") {
      description = rest.shift() as string;
    }

    let paramsSchema: ZodRawShape | undefined;
    if (rest.length > 1) {
      paramsSchema = rest.shift() as ZodRawShape;
    }

    const cb = rest[0] as ToolCallback<ZodRawShape | undefined>;
    const registeredTool: RegisteredTool = {
      description,
      inputSchema:
        paramsSchema === undefined ? undefined : z.object(paramsSchema),
      callback: cb,
      enabled: true,
      disable: () => {
        if (!registeredTool.enabled) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "tool",
          capabilityName: name,
          action: "disabled",
        }));

        registeredTool.update({ enabled: false });
      },
      enable: () => {
        if (registeredTool.enabled) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "tool",
          capabilityName: name,
          action: "enabled",
        }));

        registeredTool.update({ enabled: true });
      },
      remove: () => {
        if (name === null) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "tool",
          capabilityName: name,
          action: "removed",
        }));

        registeredTool.update({ name: null });
      },
      update: (updates) => {
        let added = false;
        let removed = false;
        let updated = false;
        let enabled = false;

        if (typeof updates.name !== "undefined" && updates.name !== name) {
          removed = true;
          delete this._registeredTools[name];

          if (updates.name) {
            added = true;
            this._registeredTools[updates.name] = registeredTool;
          }
        }

        if (
          typeof updates.description !== "undefined" &&
          updates.description !== description
        ) {
          updated = true;
          registeredTool.description = updates.description;
        }

        if (
          typeof updates.paramsSchema !== "undefined" &&
          updates.paramsSchema !== paramsSchema
        ) {
          updated = true;
          registeredTool.inputSchema = z.object(updates.paramsSchema);
        }

        if (
          typeof updates.callback !== "undefined" &&
          updates.callback !== registeredTool.callback
        ) {
          updated = true;
          registeredTool.callback = updates.callback;
        }

        if (
          typeof updates.enabled !== "undefined" &&
          updates.enabled !== registeredTool.enabled
        ) {
          enabled = true;
          registeredTool.enabled = updates.enabled;
        }

        if (removed) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "tool",
            capabilityName: name,
            action: "removed",
          }));
        }

        if (added) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "tool",
            capabilityName: updates.name || name,
            action: "added",
          }));
        }

        if (updated) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "tool",
            capabilityName: updates.name || name,
            action: "updated",
          }));
        }

        if (enabled) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "tool",
            capabilityName: updates.name || name,
            action: registeredTool.enabled ? "enabled" : "disabled",
          }));
        }

        this.sendToolListChanged();
      },
    };
    this._registeredTools[name] = registeredTool;

    this._onCapabilityChange.notify(() => ({
      serverInfo: this.server.getVersion(),
      capabilityType: "tool",
      capabilityName: name,
      action: "added",
    }));

    this.setToolRequestHandlers();
    this.sendToolListChanged()

    return registeredTool
  }

  /**
   * Registers a zero-argument prompt `name`, which will run the given function when the client calls it.
   */
  prompt(name: string, cb: PromptCallback): RegisteredPrompt;

  /**
   * Registers a zero-argument prompt `name` (with a description) which will run the given function when the client calls it.
   */
  prompt(name: string, description: string, cb: PromptCallback): RegisteredPrompt;

  /**
   * Registers a prompt `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): RegisteredPrompt;

  /**
   * Registers a prompt `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    description: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): RegisteredPrompt;

  prompt(name: string, ...rest: unknown[]): RegisteredPrompt {
    if (this._registeredPrompts[name]) {
      throw new Error(`Prompt ${name} is already registered`);
    }

    let description: string | undefined;
    if (typeof rest[0] === "string") {
      description = rest.shift() as string;
    }

    let argsSchema: PromptArgsRawShape | undefined;
    if (rest.length > 1) {
      argsSchema = rest.shift() as PromptArgsRawShape;
    }

    const cb = rest[0] as PromptCallback<PromptArgsRawShape | undefined>;
    const registeredPrompt: RegisteredPrompt = {
      description,
      argsSchema: argsSchema === undefined ? undefined : z.object(argsSchema),
      callback: cb,
      enabled: true,
      disable: () => {
        if (!registeredPrompt.enabled) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "prompt",
          capabilityName: name,
          action: "disabled",
        }));

        registeredPrompt.update({ enabled: false });
      },
      enable: () => {
        if (registeredPrompt.enabled) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "prompt",
          capabilityName: name,
          action: "enabled",
        }));

        registeredPrompt.update({ enabled: true });
      },
      remove: () => {
        if (name === null) return;

        this._onCapabilityChange.notify(() => ({
          serverInfo: this.server.getVersion(),
          capabilityType: "prompt",
          capabilityName: name,
          action: "removed",
        }));

        registeredPrompt.update({ name: null });
      },
      update: (updates) => {
        let added = false;
        let removed = false;
        let updated = false;
        let enabled = false;

        if (typeof updates.name !== "undefined" && updates.name !== name) {
          removed = true;
          delete this._registeredPrompts[name];

          if (updates.name) {
            added = true;
            this._registeredPrompts[updates.name!] = registeredPrompt;
          }
        }

        if (
          typeof updates.description !== "undefined" &&
          updates.description !== description
        ) {
          updated = true;
          registeredPrompt.description = updates.description;
        }

        if (
          typeof updates.argsSchema !== "undefined" &&
          updates.argsSchema !== argsSchema
        ) {
          updated = true;
          registeredPrompt.argsSchema = z.object(updates.argsSchema);
        }

        if (
          typeof updates.callback !== "undefined" &&
          updates.callback !== registeredPrompt.callback
        ) {
          updated = true;
          registeredPrompt.callback = updates.callback;
        }

        if (
          typeof updates.enabled !== "undefined" &&
          updates.enabled !== registeredPrompt.enabled
        ) {
          enabled = true;
          registeredPrompt.enabled = updates.enabled;
        }

        if (removed) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "prompt",
            capabilityName: name,
            action: "removed",
          }));
        }

        if (added) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "prompt",
            capabilityName: updates.name || name,
            action: "added",
          }));
        }

        if (updated) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "prompt",
            capabilityName: updates.name || name,
            action: "updated",
          }));
        }

        if (enabled) {
          this._onCapabilityChange.notify(() => ({
            serverInfo: this.server.getVersion(),
            capabilityType: "prompt",
            capabilityName: updates.name || name,
            action: registeredPrompt.enabled ? "enabled" : "disabled",
          }));
        }

        this.sendPromptListChanged();
      },
    };
    this._registeredPrompts[name] = registeredPrompt;

    this._onCapabilityChange.notify(() => ({
      serverInfo: this.server.getVersion(),
      capabilityType: "prompt",
      capabilityName: name,
      action: "added",
    }));

    this.setPromptRequestHandlers();
    this.sendPromptListChanged()

    return registeredPrompt
  }

  /**
   * Checks if the server is connected to a transport.
   * @returns True if the server is connected
   */
  isConnected() {
    return this.server.transport !== undefined
  }

  /**
   * Sends a resource list changed event to the client, if connected.
   */
  sendResourceListChanged() {
    if (this.isConnected()) {
      this.server.sendResourceListChanged();
    }
  }

  /**
   * Sends a tool list changed event to the client, if connected.
   */
  sendToolListChanged() {
    if (this.isConnected()) {
      this.server.sendToolListChanged();
    }
  }

  /**
   * Sends a prompt list changed event to the client, if connected.
   */
  sendPromptListChanged() {
    if (this.isConnected()) {
      this.server.sendPromptListChanged();
    }
  }
}

/**
 * A callback to complete one variable within a resource template's URI template.
 */
export type CompleteResourceTemplateCallback = (
  value: string,
) => string[] | Promise<string[]>;

/**
 * A resource template combines a URI pattern with optional functionality to enumerate
 * all resources matching that pattern.
 */
export class ResourceTemplate {
  private _uriTemplate: UriTemplate;

  constructor(
    uriTemplate: string | UriTemplate,
    private _callbacks: {
      /**
       * A callback to list all resources matching this template. This is required to specified, even if `undefined`, to avoid accidentally forgetting resource listing.
       */
      list: ListResourcesCallback | undefined;

      /**
       * An optional callback to autocomplete variables within the URI template. Useful for clients and users to discover possible values.
       */
      complete?: {
        [variable: string]: CompleteResourceTemplateCallback;
      };
    },
  ) {
    this._uriTemplate =
      typeof uriTemplate === "string"
        ? new UriTemplate(uriTemplate)
        : uriTemplate;
  }

  /**
   * Gets the URI template pattern.
   */
  get uriTemplate(): UriTemplate {
    return this._uriTemplate;
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
  completeCallback(
    variable: string,
  ): CompleteResourceTemplateCallback | undefined {
    return this._callbacks.complete?.[variable];
  }
}

/**
 * Callback for a tool handler registered with Server.tool().
 *
 * Parameters will include tool arguments, if applicable, as well as other request handler context.
 */
export type ToolCallback<Args extends undefined | ZodRawShape = undefined> =
  Args extends ZodRawShape
    ? (
        args: z.objectOutputType<Args, ZodTypeAny>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ) => CallToolResult | Promise<CallToolResult>
    : (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => CallToolResult | Promise<CallToolResult>;

export type RegisteredTool = {
  description?: string;
  inputSchema?: AnyZodObject;
  callback: ToolCallback<undefined | ZodRawShape>;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update<Args extends ZodRawShape>(updates: { name?: string | null, description?: string, paramsSchema?: Args, callback?: ToolCallback<Args>, enabled?: boolean }): void
  remove(): void
};

const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object" as const,
};

/**
 * Additional, optional information for annotating a resource.
 */
export type ResourceMetadata = Omit<Resource, "uri" | "name">;

/**
 * Callback to list all resources matching a given template.
 */
export type ListResourcesCallback = (
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (
  uri: URL,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => ReadResourceResult | Promise<ReadResourceResult>;

export type RegisteredResource = {
  name: string;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceCallback;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: { name?: string, uri?: string | null, metadata?: ResourceMetadata, callback?: ReadResourceCallback, enabled?: boolean }): void
  remove(): void
};

/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
export type ReadResourceTemplateCallback = (
  uri: URL,
  variables: Variables,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => ReadResourceResult | Promise<ReadResourceResult>;

export type RegisteredResourceTemplate = {
  resourceTemplate: ResourceTemplate;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceTemplateCallback;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: { name?: string | null, template?: ResourceTemplate, metadata?: ResourceMetadata, callback?: ReadResourceTemplateCallback, enabled?: boolean  }): void
  remove(): void
};

type PromptArgsRawShape = {
  [k: string]:
    | ZodType<string, ZodTypeDef, string>
    | ZodOptional<ZodType<string, ZodTypeDef, string>>;
};

export type PromptCallback<
  Args extends undefined | PromptArgsRawShape = undefined,
> = Args extends PromptArgsRawShape
  ? (
      args: z.objectOutputType<Args, ZodTypeAny>,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => GetPromptResult | Promise<GetPromptResult>
  : (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>;

export type RegisteredPrompt = {
  description?: string;
  argsSchema?: ZodObject<PromptArgsRawShape>;
  callback: PromptCallback<undefined | PromptArgsRawShape>;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update<Args extends PromptArgsRawShape>(updates: { name?: string | null, description?: string, argsSchema?: Args, callback?: PromptCallback<Args>, enabled?: boolean }): void
  remove(): void
};

function promptArgumentsFromSchema(
  schema: ZodObject<PromptArgsRawShape>,
): PromptArgument[] {
  return Object.entries(schema.shape).map(
    ([name, field]): PromptArgument => ({
      name,
      description: field.description,
      required: !field.isOptional(),
    }),
  );
}

function createCompletionResult(suggestions: string[]): CompleteResult {
  return {
    completion: {
      values: suggestions.slice(0, 100),
      total: suggestions.length,
      hasMore: suggestions.length > 100,
    },
  };
}

const EMPTY_COMPLETION_RESULT: CompleteResult = {
  completion: {
    values: [],
    hasMore: false,
  },
};

/**
 * Represents events emitted when capabilities (tools, resources, prompts) change state or are invoked.
 *
 * These events allow tracking the lifecycle and usage of all capabilities registered with an McpServer.
 * Events include capability registration, updates, invocation, completion, and errors.
 *
 * Each capability type (tool, resource, prompt) maintains its own sequence of invocation indexes.
 * The invocationIndex can be used to correlate "invoked" events with their corresponding
 * "completed" or "error" events for the same capability type.
 */
export type CapabilityEvent = {
  /** Information about the server that generated this event */
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** The type of capability this event relates to */
  readonly capabilityType: "resource" | "tool" | "prompt";
  /** The name (or URI for resources) of the specific capability */
  readonly capabilityName: string;
} & (
  | {
      /**
       * Lifecycle events for capability registration and status changes.
       * - "added": The capability was registered
       * - "updated": The capability was modified
       * - "removed": The capability was unregistered
       * - "enabled": The capability was enabled
       * - "disabled": The capability was disabled
       */
      readonly action: "added" | "updated" | "removed" | "enabled" | "disabled";
    }
  | {
      /** Emitted when a capability is invoked */
      readonly action: "invoked";
      /**
       * Monotonically increasing index for each invocation, per capability type.
       * This index can be used to correlate this "invoked" event with a later
       * "completed" or "error" event with the same capabilityType and invocationIndex.
       */
      readonly invocationIndex: number;
      /** The arguments passed to the capability, if any */
      readonly arguments?: unknown;
    }
  | {
      /** Emitted when a capability invocation completes successfully */
      readonly action: "completed";
      /**
       * The invocationIndex from the corresponding "invoked" event.
       * This allows correlating the completion with its invocation.
       */
      readonly invocationIndex: number;
      /** The result returned by the capability, if any */
      readonly result?: unknown;
      /** The duration of the operation in milliseconds, measured from invocation to completion */
      readonly durationMs?: number;
    }
  | {
      /** Emitted when a capability invocation fails with an error */
      readonly action: "error";
      /**
       * The invocationIndex from the corresponding "invoked" event.
       * This allows correlating the error with its invocation.
       */
      readonly invocationIndex: number;
      /** The error that occurred during capability execution */
      readonly error: unknown;
      /** The duration from invocation to error in milliseconds */
      readonly durationMs?: number;
    }
);
