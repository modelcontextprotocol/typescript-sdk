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

type McpServerOptions = ServerOptions & {
  render?: <T extends Record<string, any>>(inserts: any, args: T) => void;
  locked?: boolean;
}

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
  private _options?: McpServerOptions

  constructor(serverInfo: Implementation, options?: McpServerOptions) {
    this.server = new Server(serverInfo, options);
    this._options = options
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
   * These are called after a render() method has added, removed, or updated any prompts/resources/tools
   */
  private emitPromptsChangedEvent(/* todo: how to track changes? */) {
    // todo send notification event
  }

  private emitResourcesChangedEvent(/* todo: how to track changes? */) {
    // todo send notification event
  }

  private emitToolsChangedEvent(/* todo: how to track changes? */) {
    // todo send notification event
  }

  /**
   * Registers a resource `name` at a fixed URI, which will use the given callback to respond to read requests.
   */
  resource(name: string, uri: string, readCallback: ReadResourceCallback): void;

  /**
   * Registers a resource `name` at a fixed URI with metadata, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a template pattern, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    template: ResourceTemplate,
    readCallback: ReadResourceTemplateCallback,
  ): void;

  /**
   * Registers a resource `name` with a template pattern and metadata, which will use the given callback to respond to read requests.
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

    this.setResourceRequestHandlers();
  }

  /**
   * Registers a zero-argument tool `name`, which will run the given function when the client calls it.
   */
  tool(name: string, cb: ToolCallback): void;

  /**
   * Registers a zero-argument tool `name` (with a description) which will run the given function when the client calls it.
   */
  tool(name: string, description: string, cb: ToolCallback): void;

  /**
   * Registers a tool `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  /**
   * Registers a tool `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  tool(name: string, ...rest: unknown[]): void {
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
    this._registeredTools[name] = {
      description,
      inputSchema:
        paramsSchema === undefined ? undefined : z.object(paramsSchema),
      callback: cb,
    };

    this.setToolRequestHandlers();
  }

  /**
   * Registers a zero-argument prompt `name`, which will run the given function when the client calls it.
   */
  prompt(name: string, cb: PromptCallback): void;

  /**
   * Registers a zero-argument prompt `name` (with a description) which will run the given function when the client calls it.
   */
  prompt(name: string, description: string, cb: PromptCallback): void;

  /**
   * Registers a prompt `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): void;

  /**
   * Registers a prompt `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  prompt<Args extends PromptArgsRawShape>(
    name: string,
    description: string,
    argsSchema: Args,
    cb: PromptCallback<Args>,
  ): void;

  prompt(name: string, ...rest: unknown[]): void {
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
    this._registeredPrompts[name] = {
      description,
      argsSchema: argsSchema === undefined ? undefined : z.object(argsSchema),
      callback: cb,
    };

    this.setPromptRequestHandlers();
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
