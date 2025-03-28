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
} from "../types.js";
import { Completable, CompletableDef } from "./completable.js";
import { UriTemplate, Variables } from "../shared/uriTemplate.js";
import { RequestHandlerExtra } from "../shared/protocol.js";
import { Transport } from "../shared/transport.js";

type RenderApi = {
  resource: McpServer["resource"];
  tool: McpServer["tool"];
  prompt: McpServer["prompt"];
};

type McpServerOptions<T extends Record<string, any> = Record<string, any>> =
  ServerOptions & {
  render?: (api: RenderApi, args: T) => void | Promise<void>;
  locked?: boolean;
};

/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * Server instance available via the `server` property.
 */
export class McpServer<RenderArgs extends Record<string, any> = Record<string, any>> {
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

  private readonly _renderFunction?: (
    api: RenderApi,
    args: RenderArgs,
  ) => void | Promise<void>;
  private readonly _locked: boolean;
  private _isFirstRender: boolean = true;

  constructor(serverInfo: Implementation, options?: McpServerOptions<RenderArgs>) {
    this.server = new Server(serverInfo, options);
    this._renderFunction = options?.render;
    this._locked = options?.locked ?? false;

    if (this._locked && !this._renderFunction) {
      throw new Error(
        "McpServer is locked, but no render function was provided. No resources, tools, or prompts can be registered.",
      );
    }
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
    await this.server.close();
  }

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
      },
    });

    this.server.setRequestHandler(
      ListToolsRequestSchema,
      (): ListToolsResult => ({
        tools: Object.entries(this._registeredTools).map(
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

        if (tool.inputSchema) {
          const parseResult = await tool.inputSchema.safeParseAsync(
            request.params.arguments,
          );
          if (!parseResult.success) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid arguments for tool ${request.params.name}: ${parseResult.error.message}`,
            );
          }

          const args = parseResult.data;
          const cb = tool.callback as ToolCallback<ZodRawShape>;
          try {
            return await Promise.resolve(cb(args, extra));
          } catch (error) {
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
            return await Promise.resolve(cb(extra));
          } catch (error) {
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
        `Prompt ${request.params.ref.name} not found`,
      );
    }

    if (!prompt.argsSchema) {
      return EMPTY_COMPLETION_RESULT;
    }

    const field = prompt.argsSchema.shape[request.params.argument.name];
    if (!(field instanceof Completable)) {
      return EMPTY_COMPLETION_RESULT;
    }

    const def: CompletableDef<ZodString> = field._def;
    const suggestions = await def.complete(request.params.argument.value);
    return createCompletionResult(suggestions);
  }

  private async handleResourceCompletion(
    request: CompleteRequest,
    ref: ResourceReference,
  ): Promise<CompleteResult> {
    const template = Object.values(this._registeredResourceTemplates).find(
      (t) => t.resourceTemplate.uriTemplate.toString() === ref.uri,
    );

    if (!template) {
      if (this._registeredResources[ref.uri]) {
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
      return EMPTY_COMPLETION_RESULT;
    }

    const suggestions = await completer(request.params.argument.value);
    return createCompletionResult(suggestions);
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
      },
    });

    this.server.setRequestHandler(
      ListResourcesRequestSchema,
      async (request, extra) => {
        const resources = Object.entries(this._registeredResources).map(
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
          return resource.readCallback(uri, extra);
        }

        // Then check templates
        for (const template of Object.values(
          this._registeredResourceTemplates,
        )) {
          const variables = template.resourceTemplate.uriTemplate.match(
            uri.toString(),
          );
          if (variables) {
            return template.readCallback(uri, variables, extra);
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
      },
    });

    this.server.setRequestHandler(
      ListPromptsRequestSchema,
      (): ListPromptsResult => ({
        prompts: Object.entries(this._registeredPrompts).map(
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

        if (prompt.argsSchema) {
          const parseResult = await prompt.argsSchema.safeParseAsync(
            request.params.arguments,
          );
          if (!parseResult.success) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid arguments for prompt ${request.params.name}: ${parseResult.error.message}`,
            );
          }

          const args = parseResult.data;
          const cb = prompt.callback as PromptCallback<PromptArgsRawShape>;
          return await Promise.resolve(cb(args, extra));
        } else {
          const cb = prompt.callback as PromptCallback<undefined>;
          return await Promise.resolve(cb(extra));
        }
      },
    );

    this.setCompletionRequestHandler();

    this._promptHandlersInitialized = true;
  }

  /**
   * Clears existing resources, tools, and prompts, then runs the configured `render` function
   * to define a new set based on the provided arguments.
   * If the set of registered items changes compared to the previous state (and it's not the first render),
   * appropriate `/listChanged` notifications are sent.
   *
   * @param args Arguments to pass to the configured `render` function.
   * @throws Error if no `render` function was provided in the constructor options.
   */
  async render(args: RenderArgs): Promise<void> {
    if (!this._renderFunction) {
      throw new Error(
        "Cannot call render(). No render function was provided during McpServer initialization.",
      );
    }

    // --- 1. Prepare for new render ---
    const newResources: { [uri: string]: RegisteredResource } = {};
    const newResourceTemplates: { [name: string]: RegisteredResourceTemplate } =
      {};
    const newTools: { [name: string]: RegisteredTool } = {};
    const newPrompts: { [name: string]: RegisteredPrompt } = {};

    // --- 2. Create temporary registration API for the render function ---
    // These functions capture the definitions into the 'new*' objects above.
    // They mirror the public API but don't check for locking or emit events immediately.
    const renderApi: RenderApi = {
      resource: (
        name: string,
        uriOrTemplate: string | ResourceTemplate,
        ...rest: unknown[]
      ): void => {
        let metadata: ResourceMetadata | undefined;
        if (rest.length > 1 && typeof rest[0] === "object" && rest[0] !== null && !(rest[0] instanceof Function)) {
           metadata = rest.shift() as ResourceMetadata;
        }

        const readCallback = rest[0] as
          | ReadResourceCallback
          | ReadResourceTemplateCallback;

        if (typeof uriOrTemplate === "string") {
          if (newResources[uriOrTemplate]) {
            console.warn(
              `Resource URI '${uriOrTemplate}' defined multiple times within the same render cycle. Last definition wins.`,
            );
          }
          newResources[uriOrTemplate] = {
            name,
            metadata,
            readCallback: readCallback as ReadResourceCallback,
          };
        } else {
          if (newResourceTemplates[name]) {
            console.warn(
              `Resource template '${name}' defined multiple times within the same render cycle. Last definition wins.`,
            );
          }
          newResourceTemplates[name] = {
            resourceTemplate: uriOrTemplate,
            metadata,
            readCallback: readCallback as ReadResourceTemplateCallback,
          };
        }
      },
      tool: (name: string, ...rest: unknown[]): void => {
        if (newTools[name]) {
          console.warn(
            `Tool '${name}' defined multiple times within the same render cycle. Last definition wins.`,
          );
        }

        let description: string | undefined;
        if (typeof rest[0] === "string") {
          description = rest.shift() as string;
        }

        let paramsSchema: ZodRawShape | undefined;
        // Check if the next item is an object but not the callback function
        if (rest.length > 1 && typeof rest[0] === 'object' && rest[0] !== null && !(rest[0] instanceof Function)) {
          paramsSchema = rest.shift() as ZodRawShape;
        }

        const cb = rest[0] as ToolCallback<ZodRawShape | undefined>;
        newTools[name] = {
          description,
          inputSchema:
            paramsSchema === undefined ? undefined : z.object(paramsSchema),
          callback: cb,
        };
      },
      prompt: (name: string, ...rest: unknown[]): void => {
        if (newPrompts[name]) {
          console.warn(
            `Prompt '${name}' defined multiple times within the same render cycle. Last definition wins.`,
          );
        }

        let description: string | undefined;
        if (typeof rest[0] === "string") {
          description = rest.shift() as string;
        }

        let argsSchema: PromptArgsRawShape | undefined;
         // Check if the next item is an object but not the callback function
        if (rest.length > 1 && typeof rest[0] === 'object' && rest[0] !== null && !(rest[0] instanceof Function)) {
           argsSchema = rest.shift() as PromptArgsRawShape;
        }


        const cb = rest[0] as PromptCallback<
          PromptArgsRawShape | undefined
        >;
        newPrompts[name] = {
          description,
          argsSchema:
            argsSchema === undefined ? undefined : z.object(argsSchema),
          callback: cb,
        };
      },
    };

    // --- 3. Execute the user's render function ---
    this._renderFunction(renderApi, args)

    // --- 4. Compare old state with new state ---
    const toolsChanged = haveKeysChanged(this._registeredTools, newTools);
    const promptsChanged = haveKeysChanged(this._registeredPrompts, newPrompts);
    const resourcesChanged = haveKeysChanged(
      {
        ...this._registeredResources,
        ...mapKeys(this._registeredResourceTemplates, (t) => t.resourceTemplate.uriTemplate.toString()) // Use template URI for comparison consistency if needed, or just name
      },
      {
        ...newResources,
        ...mapKeys(newResourceTemplates, (t) => t.resourceTemplate.uriTemplate.toString())
      }
    ) || haveKeysChanged(this._registeredResourceTemplates, newResourceTemplates); // Also check template names directly

    // --- 5. Always update internal state (currently we're not emitting events for changes in parameters or descriptions
    // of tools, but we should at least store the new values
    this._registeredTools = newTools;
    this._registeredPrompts = newPrompts;
    this._registeredResources = newResources;
    this._registeredResourceTemplates = newResourceTemplates;

    // Ensure handlers are set up
    this.setToolRequestHandlers();
    this.setPromptRequestHandlers();
    this.setResourceRequestHandlers();

    // Emit change events only if state *actually* changed and it's not the first render
    if (!this._isFirstRender) {
      if (toolsChanged) this.server.sendToolListChanged()
      if (promptsChanged) this.server.sendPromptListChanged()
      if (resourcesChanged) this.server.sendResourceListChanged()
    }

    // --- 6. Mark first render as complete ---
    this._isFirstRender = false;
  }

  /**
   * Registers a resource `name` at a fixed URI, which will use the given callback to respond to read requests.
   * @throws Error if the server is locked.
   */
  resource(name: string, uri: string, readCallback: ReadResourceCallback): void;

  /**
   * Registers a resource `name` at a fixed URI with metadata, which will use the given callback to respond to read requests.
   * @throws Error if the server is locked.
   */
  resource(
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a template pattern, which will use the given callback to respond to read requests.
   * @throws Error if the server is locked.
   */
  resource(
    name: string,
    template: ResourceTemplate,
    readCallback: ReadResourceTemplateCallback,
  ): void;

  /**
   * Registers a resource `name` with a template pattern and metadata, which will use the given callback to respond to read requests.
   * @throws Error if the server is locked.
   */
  resource(
    name: string,
    template: ResourceTemplate,
    metadata: ResourceMetadata,
    readCallback: ReadResourceTemplateCallback,
  ): void;

  resource(
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    ...rest: unknown[]
  ): void {
    if (this._locked) {
      throw new Error(
        "Server is locked. Resources can only be registered via the render() method.",
      );
    }

    let metadata: ResourceMetadata | undefined;
    // Check if the first rest arg is metadata (object, not function)
    if (rest.length > 1 && typeof rest[0] === "object" && rest[0] !== null && !(rest[0] instanceof Function)) {
        metadata = rest.shift() as ResourceMetadata;
    }

    const readCallback = rest[0] as
      | ReadResourceCallback
      | ReadResourceTemplateCallback;

    if (typeof uriOrTemplate === "string") {
      if (this._registeredResources[uriOrTemplate]) {
        throw new Error(`Resource ${uriOrTemplate} is already registered`);
      }

      this._registeredResources[uriOrTemplate] = {
        name,
        metadata,
        readCallback: readCallback as ReadResourceCallback,
      };
    } else {
      if (this._registeredResourceTemplates[name]) {
        throw new Error(`Resource template ${name} is already registered`);
      }

      this._registeredResourceTemplates[name] = {
        resourceTemplate: uriOrTemplate,
        metadata,
        readCallback: readCallback as ReadResourceTemplateCallback,
      };
    }

    this.setResourceRequestHandlers()
    this.server.sendResourceListChanged()
  }

  /**
   * Registers a zero-argument tool `name`, which will run the given function when the client calls it.
   * @throws Error if the server is locked.
   */
  tool(name: string, cb: ToolCallback): void;

  /**
   * Registers a zero-argument tool `name` (with a description) which will run the given function when the client calls it.
   * @throws Error if the server is locked.
   */
  tool(name: string, description: string, cb: ToolCallback): void;

  /**
   * Registers a tool `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   * @throws Error if the server is locked.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  /**
   * Registers a tool `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   * @throws Error if the server is locked.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  tool(name: string, ...rest: unknown[]): void {
    if (this._locked) {
      throw new Error(
        "Server is locked. Tools can only be registered via the render() method.",
      );
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
    this._registeredTools[name] = {
      description,
      inputSchema:
        paramsSchema === undefined ? undefined : z.object(paramsSchema),
      callback: cb,
    };

    this.setToolRequestHandlers();
    this.server.sendToolListChanged();
  }

  /**
   * Registers a zero-argument prompt `name`, which will run the given function when the client calls it.
   * @throws Error if the server is locked.
   */
  prompt(name: string, cb: PromptCallback): void;

  /**
   * Registers a zero-argument prompt `name` (with a description) which will run the given function when the client calls it.
   * @throws Error if the server is locked.
   */
  prompt(name: string, description: string, cb: PromptCallback): void;

  /**
   * Registers a prompt `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   * @throws Error if the server is locked.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): void;

  /**
   * Registers a prompt `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   * @throws Error if the server is locked.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    description: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): void;

  prompt(name: string, ...rest: unknown[]): void {
    if (this._locked) {
      throw new Error(
        "Server is locked. Prompts can only be registered via the render() method.",
      );
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
    this._registeredPrompts[name] = {
      description,
      argsSchema: argsSchema === undefined ? undefined : z.object(argsSchema),
      callback: cb,
    };

    this.setPromptRequestHandlers();
    this.server.sendPromptListChanged()
  }
}

// --- Helper Function for Change Detection ---

/** Checks if the keys of two objects are different. */
function haveKeysChanged(oldObj: object, newObj: object): boolean {
  const oldKeys = Object.keys(oldObj).sort();
  const newKeys = Object.keys(newObj).sort();

  if (oldKeys.length !== newKeys.length) {
    return true;
  }

  for (let i = 0; i < oldKeys.length; i++) {
    if (oldKeys[i] !== newKeys[i]) {
      return true;
    }
  }

  return false;
}

/** Helper to map object keys while preserving values. */
function mapKeys<V>(obj: Record<string, V>, keyMapper: (value: V, key: string) => string): Record<string, V> {
    const result: Record<string, V> = {};
    for(const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            const newKey = keyMapper(obj[key], key);
            result[newKey] = obj[key];
        }
    }
    return result;
}


// --- Constants and Type Definitions (mostly unchanged) ---

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
        extra: RequestHandlerExtra,
      ) => CallToolResult | Promise<CallToolResult>
    : (extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>;

type RegisteredTool = {
  description?: string;
  inputSchema?: AnyZodObject;
  callback: ToolCallback<undefined | ZodRawShape>;
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
  extra: RequestHandlerExtra,
) => ListResourcesResult | Promise<ListResourcesResult>;

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (
  uri: URL,
  extra: RequestHandlerExtra,
) => ReadResourceResult | Promise<ReadResourceResult>;

type RegisteredResource = {
  name: string;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceCallback;
};

/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
export type ReadResourceTemplateCallback = (
  uri: URL,
  variables: Variables,
  extra: RequestHandlerExtra,
) => ReadResourceResult | Promise<ReadResourceResult>;

type RegisteredResourceTemplate = {
  resourceTemplate: ResourceTemplate;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceTemplateCallback;
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
      extra: RequestHandlerExtra,
    ) => GetPromptResult | Promise<GetPromptResult>
  : (extra: RequestHandlerExtra) => GetPromptResult | Promise<GetPromptResult>;

type RegisteredPrompt = {
  description?: string;
  argsSchema?: ZodObject<PromptArgsRawShape>;
  callback: PromptCallback<undefined | PromptArgsRawShape>;
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
