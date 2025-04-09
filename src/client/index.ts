import {
  mergeCapabilities,
  Protocol,
  ProtocolOptions,
  RequestOptions,
} from "../shared/protocol.js";
import { Transport } from "../shared/transport.js";
import {
  CallToolRequest,
  CallToolResultSchema,
  ClientCapabilities,
  ClientNotification,
  ClientRequest,
  ClientResult,
  CompatibilityCallToolResultSchema,
  CompleteRequest,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptRequest,
  GetPromptResultSchema,
  Implementation,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequest,
  ListPromptsResultSchema,
  ListResourcesRequest,
  ListResourcesResultSchema,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResultSchema,
  ListToolsRequest,
  ListToolsResult,
  ListToolsResultSchema,
  LoggingLevel,
  Notification,
  ReadResourceRequest,
  ReadResourceResultSchema,
  Request,
  Result,
  ServerCapabilities,
  SubscribeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsubscribeRequest,
} from "../types.js";

export type ClientOptions = ProtocolOptions & {
  /**
   * Capabilities to advertise as being supported by this client.
   */
  capabilities?: ClientCapabilities;
  /**
   * Configure automatic refresh behavior for tool list changes
   */
  toolRefreshOptions?: {
    /**
     * Whether to automatically refresh the tools list when a change notification is received.
     * Default: true
     */
    autoRefresh?: boolean;
    /**
     * Debounce time in milliseconds for tool list refresh operations.
     * Multiple notifications received within this timeframe will only trigger one refresh.
     * Default: 300
     */
    debounceMs?: number;
    /**
     * Optional callback for handling tool list refresh errors.
     * When provided, this will be called instead of logging to console.
     */
    onError?: (error: Error) => void;
  };
};

/**
 * An MCP client on top of a pluggable transport.
 *
 * The client will automatically begin the initialization flow with the server when connect() is called.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed client
 * const client = new Client<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomClient",
 *   version: "1.0.0"
 * })
 * ```
 */
export class Client<
  RequestT extends Request = Request,
  NotificationT extends Notification = Notification,
  ResultT extends Result = Result,
> extends Protocol<
  ClientRequest | RequestT,
  ClientNotification | NotificationT,
  ClientResult | ResultT
> {
  private _serverCapabilities?: ServerCapabilities;
  private _serverVersion?: Implementation;
  private _capabilities: ClientCapabilities;
  private _instructions?: string;
  private _toolRefreshOptions: {
    autoRefresh: boolean;
    debounceMs: number;
    onError?: (error: Error) => void;
  };
  private _toolRefreshDebounceTimer?: ReturnType<typeof setTimeout>;

  /**
   * Callback for when the server indicates that the tools list has changed.
   * Client should typically refresh its list of tools in response.
   */
  onToolListChanged?: (tools?: ListToolsResult["tools"]) => void;

  /**
   * Initializes this client with the given name and version information.
   */
  constructor(
    private _clientInfo: Implementation,
    options?: ClientOptions,
  ) {
    super(options);
    this._capabilities = options?.capabilities ?? {};
    this._toolRefreshOptions = {
      autoRefresh: options?.toolRefreshOptions?.autoRefresh ?? true,
      debounceMs: options?.toolRefreshOptions?.debounceMs ?? 500,
      onError: options?.toolRefreshOptions?.onError,
    };

    // Set up notification handlers
    this.setNotificationHandler(
      "notifications/tools/list_changed",
      async () => {
        // Only proceed with refresh if auto-refresh is enabled
        if (!this._toolRefreshOptions.autoRefresh) {
          // Still call callback to notify about the change, but without tools data
          this.onToolListChanged?.(undefined);
          return;
        }

        // Clear any pending refresh timer
        if (this._toolRefreshDebounceTimer) {
          clearTimeout(this._toolRefreshDebounceTimer);
        }

        // Set up debounced refresh
        this._toolRefreshDebounceTimer = setTimeout(() => {
          this._refreshToolsList().catch((error) => {
            // Use error callback if provided, otherwise log to console
            if (this._toolRefreshOptions.onError) {
              this._toolRefreshOptions.onError(error instanceof Error ? error : new Error(String(error)));
            } else {
              console.error("Failed to refresh tools list:", error);
            }
          });
        }, this._toolRefreshOptions.debounceMs);
      }
    );
  }

  /**
   * Private method to handle tools list refresh
   */
  private async _refreshToolsList(): Promise<void> {
    try {
      // Only refresh if the server supports tools
      if (this._serverCapabilities?.tools) {
        const result = await this.listTools();
        // Call the user's callback with the updated tools list
        this.onToolListChanged?.(result.tools);
      }
    } catch (error) {
      // Use error callback if provided, otherwise log to console
      if (this._toolRefreshOptions.onError) {
        this._toolRefreshOptions.onError(error instanceof Error ? error : new Error(String(error)));
      } else {
        console.error("Failed to refresh tools list:", error);
      }
      // Still call the callback even if refresh failed
      this.onToolListChanged?.(undefined);
    }
  }

  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  public registerCapabilities(capabilities: ClientCapabilities): void {
    if (this.transport) {
      throw new Error(
        "Cannot register capabilities after connecting to transport",
      );
    }

    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }

  /**
   * Updates the tool refresh options
   */
  public setToolRefreshOptions(
    options: ClientOptions["toolRefreshOptions"]
  ): void {
    if (options) {
      if (options.autoRefresh !== undefined) {
        this._toolRefreshOptions.autoRefresh = options.autoRefresh;
      }
      if (options.debounceMs !== undefined) {
        this._toolRefreshOptions.debounceMs = options.debounceMs;
      }
      if (options.onError !== undefined) {
        this._toolRefreshOptions.onError = options.onError;
      }
    }
  }

  /**
   * Gets the current tool refresh options
   */
  public getToolRefreshOptions(): typeof this._toolRefreshOptions {
    return { ...this._toolRefreshOptions };
  }

  /**
   * Sets an error handler for tool list refresh errors
   * 
   * @param handler Function to call when a tool list refresh error occurs
   */
  public setToolRefreshErrorHandler(handler: (error: Error) => void): void {
    this._toolRefreshOptions.onError = handler;
  }

  /**
   * Manually triggers a refresh of the tools list
   */
  public async refreshToolsList(): Promise<
    ListToolsResult["tools"] | undefined
  > {
    if (!this._serverCapabilities?.tools) {
      return undefined;
    }

    try {
      const result = await this.listTools();
      return result.tools;
    } catch (error) {
      // Use error callback if provided, otherwise log to console
      if (this._toolRefreshOptions.onError) {
        this._toolRefreshOptions.onError(error instanceof Error ? error : new Error(String(error)));
      } else {
        console.error("Failed to manually refresh tools list:", error);
      }
      return undefined;
    }
  }

  protected assertCapability(
    capability: keyof ServerCapabilities,
    method: string,
  ): void {
    if (!this._serverCapabilities?.[capability]) {
      throw new Error(
        `Server does not support ${String(capability)} (required for ${method})`,
      );
    }
  }

  override async connect(transport: Transport): Promise<void> {
    await super.connect(transport);

    try {
      const result = await this.request(
        {
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: this._capabilities,
            clientInfo: this._clientInfo,
          },
        },
        InitializeResultSchema,
      );

      if (result === undefined) {
        throw new Error(`Server sent invalid initialize result: ${result}`);
      }

      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new Error(
          `Server's protocol version is not supported: ${result.protocolVersion}`,
        );
      }

      this._serverCapabilities = result.capabilities;
      this._serverVersion = result.serverInfo;

      this._instructions = result.instructions;

      await this.notification({
        method: "notifications/initialized",
      });
    } catch (error) {
      // Disconnect if initialization fails.
      void this.close();
      throw error;
    }
  }

  /**
   * After initialization has completed, this will be populated with the server's reported capabilities.
   */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this._serverCapabilities;
  }

  /**
   * After initialization has completed, this will be populated with information about the server's name and version.
   */
  getServerVersion(): Implementation | undefined {
    return this._serverVersion;
  }

  /**
   * After initialization has completed, this may be populated with information about the server's instructions.
   */
  getInstructions(): string | undefined {
    return this._instructions;
  }

  protected assertCapabilityForMethod(method: RequestT["method"]): void {
    switch (method as ClientRequest["method"]) {
      case "logging/setLevel":
        if (!this._serverCapabilities?.logging) {
          throw new Error(
            `Server does not support logging (required for ${method})`,
          );
        }
        break;

      case "prompts/get":
      case "prompts/list":
        if (!this._serverCapabilities?.prompts) {
          throw new Error(
            `Server does not support prompts (required for ${method})`,
          );
        }
        break;

      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        if (!this._serverCapabilities?.resources) {
          throw new Error(
            `Server does not support resources (required for ${method})`,
          );
        }

        if (
          method === "resources/subscribe" &&
          !this._serverCapabilities.resources.subscribe
        ) {
          throw new Error(
            `Server does not support resource subscriptions (required for ${method})`,
          );
        }

        break;

      case "tools/call":
      case "tools/list":
        if (!this._serverCapabilities?.tools) {
          throw new Error(
            `Server does not support tools (required for ${method})`,
          );
        }
        break;

      case "completion/complete":
        if (!this._serverCapabilities?.prompts) {
          throw new Error(
            `Server does not support prompts (required for ${method})`,
          );
        }
        break;

      case "initialize":
        // No specific capability required for initialize
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  protected assertNotificationCapability(
    method: NotificationT["method"],
  ): void {
    switch (method as ClientNotification["method"]) {
      case "notifications/roots/list_changed":
        if (!this._capabilities.roots?.listChanged) {
          throw new Error(
            `Client does not support roots list changed notifications (required for ${method})`
          );
        }
        break;

      case "notifications/tools/list_changed":
        if (!this._capabilities.tools?.listChanged) {
          throw new Error(
            `Client does not support tools capability (required for ${String(
              method
            )})`
          );
        }
        break;

      case "notifications/initialized":
        // No specific capability required for initialized
        break;

      case "notifications/cancelled":
        // Cancellation notifications are always allowed
        break;

      case "notifications/progress":
        // Progress notifications are always allowed
        break;
    }
  }

  protected assertRequestHandlerCapability(method: string): void {
    switch (method) {
      case "sampling/createMessage":
        if (!this._capabilities.sampling) {
          throw new Error(
            `Client does not support sampling capability (required for ${method})`,
          );
        }
        break;

      case "roots/list":
        if (!this._capabilities.roots) {
          throw new Error(
            `Client does not support roots capability (required for ${method})`,
          );
        }
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  async ping(options?: RequestOptions) {
    return this.request({ method: "ping" }, EmptyResultSchema, options);
  }

  async complete(params: CompleteRequest["params"], options?: RequestOptions) {
    return this.request(
      { method: "completion/complete", params },
      CompleteResultSchema,
      options,
    );
  }

  async setLoggingLevel(level: LoggingLevel, options?: RequestOptions) {
    return this.request(
      { method: "logging/setLevel", params: { level } },
      EmptyResultSchema,
      options,
    );
  }

  async getPrompt(
    params: GetPromptRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "prompts/get", params },
      GetPromptResultSchema,
      options,
    );
  }

  async listPrompts(
    params?: ListPromptsRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "prompts/list", params },
      ListPromptsResultSchema,
      options,
    );
  }

  async listResources(
    params?: ListResourcesRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "resources/list", params },
      ListResourcesResultSchema,
      options,
    );
  }

  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "resources/templates/list", params },
      ListResourceTemplatesResultSchema,
      options,
    );
  }

  async readResource(
    params: ReadResourceRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "resources/read", params },
      ReadResourceResultSchema,
      options,
    );
  }

  async subscribeResource(
    params: SubscribeRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "resources/subscribe", params },
      EmptyResultSchema,
      options,
    );
  }

  async unsubscribeResource(
    params: UnsubscribeRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "resources/unsubscribe", params },
      EmptyResultSchema,
      options,
    );
  }

  async callTool(
    params: CallToolRequest["params"],
    resultSchema:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema = CallToolResultSchema,
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "tools/call", params },
      resultSchema,
      options,
    );
  }

  async listTools(
    params?: ListToolsRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "tools/list", params },
      ListToolsResultSchema,
      options,
    );
  }

  /**
   * Registers a callback to be called when the server indicates that
   * the tools list has changed. The callback should typically refresh the tools list.
   *
   * @param callback Function to call when tools list changes
   */
  setToolListChangedCallback(
    callback: (tools?: ListToolsResult["tools"]) => void
  ): void {
    this.onToolListChanged = callback;
  }

  async sendRootsListChanged() {
    return this.notification({ method: "notifications/roots/list_changed" });
  }

  async sendToolListChanged() {
    return this.notification({ method: "notifications/tools/list_changed" });
  }
}
