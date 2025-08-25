import {
  mergeCapabilities,
  Protocol,
  ProtocolOptions,
  RequestOptions,
  SessionOptions,
  SessionState,
} from "../shared/protocol.js";
import { Transport } from "../shared/transport.js";
import {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResultSchema,
  ElicitRequest,
  ElicitResult,
  ElicitResultSchema,
  EmptyResultSchema,
  Implementation,
  InitializedNotificationSchema,
  InitializeRequest,
  InitializeRequestSchema,
  InitializeResult,
  LATEST_PROTOCOL_VERSION,
  ListRootsRequest,
  ListRootsResultSchema,
  LoggingMessageNotification,
  McpError,
  ErrorCode,
  Notification,
  Request,
  ResourceUpdatedNotification,
  Result,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
  ServerResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  SessionTerminateRequestSchema,
  SessionTerminateRequest,
} from "../types.js";
import Ajv from "ajv";

export type ServerOptions = ProtocolOptions & {
  /**
   * Capabilities to advertise as being supported by this server.
   */
  capabilities?: ServerCapabilities;

  /**
   * Optional instructions describing how to use the server and its features.
   */
  instructions?: string;
};

/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
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
 * // Create typed server
 * const server = new Server<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomServer",
 *   version: "1.0.0"
 * })
 * ```
 */
export class Server<
  RequestT extends Request = Request,
  NotificationT extends Notification = Notification,
  ResultT extends Result = Result,
> extends Protocol<
  ServerRequest | RequestT,
  ServerNotification | NotificationT,
  ServerResult | ResultT
> {
  private _clientCapabilities?: ClientCapabilities;
  private _clientVersion?: Implementation;
  private _capabilities: ServerCapabilities;
  private _instructions?: string;
  private _sessionOptions?: SessionOptions;

  /**
   * Callback for when initialization has fully completed (i.e., the client has sent an `initialized` notification).
   */
  oninitialized?: () => void;

  /**
   * Returns the connected transport instance.
   * Used for session-to-server routing in examples.
   */
  getTransport() {
    return this.transport;
  }

  /**
   * Initializes this server with the given name and version information.
   */
  constructor(
    private _serverInfo: Implementation,
    options?: ServerOptions,
  ) {
    // Extract session options before passing to super
    const { sessions, ...protocolOptions } = options ?? {};
    super(protocolOptions);
    this._sessionOptions = sessions;
    this._capabilities = options?.capabilities ?? {};
    this._instructions = options?.instructions;

    this.setRequestHandler(InitializeRequestSchema, (request) =>
      this._oninitialize(request),
    );
    this.setRequestHandler(SessionTerminateRequestSchema, (request) =>
      this._onSessionTerminate(request),
    );
    this.setNotificationHandler(InitializedNotificationSchema, () =>
      this.oninitialized?.(),
    );
  }

  /**
   * Handles initialization request synchronously for HTTP transport backward compatibility.
   * This bypasses the Protocol's async request handling to allow immediate error detection.
   * @internal
   */
  async handleInitializeSync(request: InitializeRequest): Promise<InitializeResult> {
    // Call the internal initialization handler directly
    const result = await this._oninitialize(request);
    return result;
  }

  /**
   * Connect to a transport, handling legacy session options from the transport.
   */
  async connect(transport: Transport): Promise<void> {
    // Handle legacy session options delegation from transport
    const legacySessionOptions = transport.getLegacySessionOptions?.();
    if (legacySessionOptions) {
      if (this._sessionOptions) {
        // Both server session options and transport legacy session options provided. Using server options.
      } else {
        this._sessionOptions = legacySessionOptions;
      }
    }
    
    // Register synchronous initialization handler if transport supports it
    if (transport.setInitializeHandler) {
      transport.setInitializeHandler((request: InitializeRequest) => 
        this.handleInitializeSync(request)
      );
    }
    
    // Register synchronous termination handler if transport supports it
    if (transport.setTerminateHandler) {
      transport.setTerminateHandler((sessionId?: string) => 
        this.terminateSession(sessionId)
      );
    }
    
    await super.connect(transport);
  }

  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  public registerCapabilities(capabilities: ServerCapabilities): void {
    if (this.transport) {
      throw new Error(
        "Cannot register capabilities after connecting to transport",
      );
    }

    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }

  protected assertCapabilityForMethod(method: RequestT["method"]): void {
    switch (method as ServerRequest["method"]) {
      case "sampling/createMessage":
        if (!this._clientCapabilities?.sampling) {
          throw new Error(
            `Client does not support sampling (required for ${method})`,
          );
        }
        break;

      case "elicitation/create":
        if (!this._clientCapabilities?.elicitation) {
          throw new Error(
            `Client does not support elicitation (required for ${method})`,
          );
        }
        break;

      case "roots/list":
        if (!this._clientCapabilities?.roots) {
          throw new Error(
            `Client does not support listing roots (required for ${method})`,
          );
        }
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  protected assertNotificationCapability(
    method: (ServerNotification | NotificationT)["method"],
  ): void {
    switch (method as ServerNotification["method"]) {
      case "notifications/message":
        if (!this._capabilities.logging) {
          throw new Error(
            `Server does not support logging (required for ${method})`,
          );
        }
        break;

      case "notifications/resources/updated":
      case "notifications/resources/list_changed":
        if (!this._capabilities.resources) {
          throw new Error(
            `Server does not support notifying about resources (required for ${method})`,
          );
        }
        break;

      case "notifications/tools/list_changed":
        if (!this._capabilities.tools) {
          throw new Error(
            `Server does not support notifying of tool list changes (required for ${method})`,
          );
        }
        break;

      case "notifications/prompts/list_changed":
        if (!this._capabilities.prompts) {
          throw new Error(
            `Server does not support notifying of prompt list changes (required for ${method})`,
          );
        }
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
            `Server does not support sampling (required for ${method})`,
          );
        }
        break;

      case "logging/setLevel":
        if (!this._capabilities.logging) {
          throw new Error(
            `Server does not support logging (required for ${method})`,
          );
        }
        break;

      case "prompts/get":
      case "prompts/list":
        if (!this._capabilities.prompts) {
          throw new Error(
            `Server does not support prompts (required for ${method})`,
          );
        }
        break;

      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        if (!this._capabilities.resources) {
          throw new Error(
            `Server does not support resources (required for ${method})`,
          );
        }
        break;

      case "tools/call":
      case "tools/list":
        if (!this._capabilities.tools) {
          throw new Error(
            `Server does not support tools (required for ${method})`,
          );
        }
        break;

      case "ping":
      case "initialize":
        // No specific capability required for these methods
        break;
    }
  }

  private async _oninitialize(
    request: InitializeRequest,
  ): Promise<InitializeResult> {
    const requestedVersion = request.params.protocolVersion;

    this._clientCapabilities = request.params.capabilities;
    this._clientVersion = request.params.clientInfo;

    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION;

    const result: InitializeResult = {
      protocolVersion,
      capabilities: this.getCapabilities(),
      serverInfo: this._serverInfo,
      ...(this._instructions && { instructions: this._instructions }),
    };

    // Generate session if supported  
    if (this._sessionOptions?.sessionIdGenerator) {
      const sessionId = this._sessionOptions.sessionIdGenerator();
      result.sessionId = sessionId;
      result.sessionTimeout = this._sessionOptions.sessionTimeout;
      
      await this.initializeSession(sessionId, this._sessionOptions.sessionTimeout);
    }

    return result;
  }

  private async initializeSession(sessionId: string, timeout?: number): Promise<void> {
    // Create the session
    this.createSession(sessionId, timeout);
    
    // Try to call the initialization callback, but if it fails,
    // store the error in session state and rethrow
    try {
      await this._sessionOptions?.onsessioninitialized?.(sessionId);
    } catch (error) {
      // Store the error in session state for the transport to check
      const sessionState = this.getSessionState();
      if (sessionState) {
        sessionState.callbackError = error instanceof Error ? error : new Error(String(error));
      }
      throw error;
    }
  }

  protected async terminateSession(sessionId?: string): Promise<void> {
    // Get the current session ID before termination
    const currentSessionId = this.getSessionState()?.sessionId;
    
    // Call parent's terminateSession to clear the session state
    await super.terminateSession(sessionId);
    
    // Now call the callback if we had a session
    if (currentSessionId) {
      try {
        await this._sessionOptions?.onsessionclosed?.(currentSessionId);
      } catch (error) {
        // Re-create minimal session state just to store the error for transport to check
        const sessionState: SessionState = {
          sessionId: currentSessionId,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          callbackError: error instanceof Error ? error : new Error(String(error))
        };
        // Notify transport of the error state
        this.transport?.setSessionState?.(sessionState);
        throw error;
      }
    }
  }

  private async _onSessionTerminate(
    request: SessionTerminateRequest
  ): Promise<object> {
    // Use the same termination logic as the protocol method
    // sessionId comes directly from the protocol request
    await this.terminateSession(request.sessionId);
    return {};
  }

  /**
   * After initialization has completed, this will be populated with the client's reported capabilities.
   */
  getClientCapabilities(): ClientCapabilities | undefined {
    return this._clientCapabilities;
  }

  /**
   * After initialization has completed, this will be populated with information about the client's name and version.
   */
  getClientVersion(): Implementation | undefined {
    return this._clientVersion;
  }

  private getCapabilities(): ServerCapabilities {
    return this._capabilities;
  }

  async ping() {
    return this.request({ method: "ping" }, EmptyResultSchema);
  }

  async createMessage(
    params: CreateMessageRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "sampling/createMessage", params },
      CreateMessageResultSchema,
      options,
    );
  }

  async elicitInput(
    params: ElicitRequest["params"],
    options?: RequestOptions,
  ): Promise<ElicitResult> {
    const result = await this.request(
      { method: "elicitation/create", params },
      ElicitResultSchema,
      options,
    );

    // Validate the response content against the requested schema if action is "accept"
    if (result.action === "accept" && result.content) {
      try {
        const ajv = new Ajv();
        
        const validate = ajv.compile(params.requestedSchema);
        const isValid = validate(result.content);
        
        if (!isValid) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Elicitation response content does not match requested schema: ${ajv.errorsText(validate.errors)}`,
          );
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Error validating elicitation response: ${error}`,
        );
      }
    }

    return result;
  }

  async listRoots(
    params?: ListRootsRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "roots/list", params },
      ListRootsResultSchema,
      options,
    );
  }

  async sendLoggingMessage(params: LoggingMessageNotification["params"]) {
    return this.notification({ method: "notifications/message", params });
  }

  async sendResourceUpdated(params: ResourceUpdatedNotification["params"]) {
    return this.notification({
      method: "notifications/resources/updated",
      params,
    });
  }

  async sendResourceListChanged() {
    return this.notification({
      method: "notifications/resources/list_changed",
    });
  }

  async sendToolListChanged() {
    return this.notification({ method: "notifications/tools/list_changed" });
  }

  async sendPromptListChanged() {
    return this.notification({ method: "notifications/prompts/list_changed" });
  }
}
