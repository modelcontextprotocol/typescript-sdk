import { IncomingMessage, ServerResponse } from "node:http";
import { Transport } from "../shared/transport.js";
import { SessionState, SessionOptions } from "../shared/protocol.js";
import { MessageExtraInfo, RequestInfo, isJSONRPCError, isJSONRPCRequest, isJSONRPCResponse, JSONRPCMessage, JSONRPCMessageSchema, RequestId, SUPPORTED_PROTOCOL_VERSIONS, DEFAULT_NEGOTIATED_PROTOCOL_VERSION, isInitializeRequest, InitializeRequest, InitializeResult } from "../types.js";
import getRawBody from "raw-body";
import contentType from "content-type";
import { randomUUID } from "node:crypto";
import { AuthInfo } from "./auth/types.js";

const MAXIMUM_MESSAGE_SIZE = "4mb";

export type StreamId = string;
export type EventId = string;

/**
 * Interface for resumability support via event storage
 */
export interface EventStore {
  /**
   * Stores an event for later retrieval
   * @param streamId ID of the stream the event belongs to
   * @param message The JSON-RPC message to store
   * @returns The generated event ID for the stored event
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

  replayEventsAfter(lastEventId: EventId, { send }: {
    send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>
  }): Promise<StreamId>;
}

/**
 * Configuration options for StreamableHTTPServerTransport
 */
export interface StreamableHTTPServerTransportOptions {
  /**
   * Function that generates a session ID for the transport.
   * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
   * 
   * Return undefined to disable session management.
   */
  sessionIdGenerator: (() => string) | undefined;

  /**
   * A callback for session initialization events
   * This is called when the server initializes a new session.
   * Useful in cases when you need to register multiple mcp sessions
   * and need to keep track of them.
   * @param sessionId The generated session ID
   */
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;

  /**
   * A callback for session close events
   * This is called when the server closes a session due to a DELETE request.
   * Useful in cases when you need to clean up resources associated with the session.
   * Note that this is different from the transport closing, if you are handling 
   * HTTP requests from multiple nodes you might want to close each 
   * StreamableHTTPServerTransport after a request is completed while still keeping the 
   * session open/running.
   * @param sessionId The session ID that was closed
  */
  onsessionclosed?: (sessionId: string) => void | Promise<void>;

  /**
   * If true, the server will return JSON responses instead of starting an SSE stream.
   * This can be useful for simple request/response scenarios without streaming.
   * Default is false (SSE streams are preferred).
   */
  enableJsonResponse?: boolean;

  /**
   * Event store for resumability support
   * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
   */
  eventStore?: EventStore;

  /**
   * List of allowed host header values for DNS rebinding protection.
   * If not specified, host validation is disabled.
   */
  allowedHosts?: string[];
  
  /**
   * List of allowed origin header values for DNS rebinding protection.
   * If not specified, origin validation is disabled.
   */
  allowedOrigins?: string[];
  
  /**
   * Enable DNS rebinding protection (requires allowedHosts and/or allowedOrigins to be configured).
   * Default is false for backwards compatibility.
   */
  enableDnsRebindingProtection?: boolean;
}

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 * 
 * Usage example:
 * 
 * ```typescript
 * // Stateful mode - server sets the session ID
 * const statefulTransport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 * });
 * 
 * // Stateless mode - explicitly set session ID to undefined
 * const statelessTransport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: undefined,
 * });
 * 
 * // Using with pre-parsed request body
 * app.post('/mcp', (req, res) => {
 *   transport.handleRequest(req, res, req.body);
 * });
 * ```
 * 
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with 404 Not Found
 * - Non-initialization requests without a session ID are rejected with 400 Bad Request
 * - State is maintained in-memory (connections, message history)
 * 
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 */
export class StreamableHTTPServerTransport implements Transport {
  private _started: boolean = false;
  private _streamMapping: Map<string, ServerResponse> = new Map();
  private _requestToStreamMapping: Map<RequestId, string> = new Map();
  private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();
  private _enableJsonResponse: boolean = false;
  private _standaloneSseStreamId: string = '_GET_stream';
  private _eventStore?: EventStore;
  private _allowedHosts?: string[];
  private _allowedOrigins?: string[];
  private _enableDnsRebindingProtection: boolean;
  private _sessionState?: SessionState; // Reference to server's session state
  private _legacySessionCallbacks?: SessionOptions; // Legacy callbacks for backward compatibility
  private _initializeHandler?: (request: InitializeRequest) => Promise<InitializeResult>; // Special handler for synchronous initialization
  private _terminateHandler?: (sessionId?: string) => Promise<void>; // Special handler for synchronous termination
  private _pendingInitResponse?: JSONRPCMessage; // Pending initialization response to send via SSE
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  /**
   * Sets the session state reference for HTTP header handling.
   * Called by the server when session is created.
   */
  setSessionState(sessionState: SessionState): void {
    this._sessionState = sessionState;
  }

  /**
   * Sets a special handler for initialization requests that bypasses async protocol handling.
   * This allows the transport to get immediate error feedback for HTTP status codes.
   * @internal
   */
  setInitializeHandler(handler: (request: InitializeRequest) => Promise<InitializeResult>): void {
    this._initializeHandler = handler;
  }

  /**
   * Sets a handler for synchronous session termination processing.
   * This allows the transport to get immediate error feedback for HTTP status codes.
   * @internal
   */
  setTerminateHandler(handler: (sessionId?: string) => Promise<void>): void {
    this._terminateHandler = handler;
  }

  /**
   * Gets the current sessionId for HTTP headers.
   * Returns undefined if no session is active.
   */
  get sessionId(): string | undefined {
    const sessionId = this._sessionState?.sessionId;
    return sessionId;
  }

  /**
   * Gets legacy session options for delegation to server.
   * Used for backward compatibility when server connects.
   */
  getLegacySessionOptions(): SessionOptions | undefined {
    return this._legacySessionCallbacks;
  }

  constructor(options?: StreamableHTTPServerTransportOptions) {
    // Store legacy session callbacks for delegation to server
    this._legacySessionCallbacks = options ? {
      sessionIdGenerator: options.sessionIdGenerator,
      onsessioninitialized: options.onsessioninitialized,
      onsessionclosed: options.onsessionclosed
    } : undefined;
    
    // Transport options
    this._enableJsonResponse = options?.enableJsonResponse ?? false;
    this._eventStore = options?.eventStore;
    this._allowedHosts = options?.allowedHosts;
    this._allowedOrigins = options?.allowedOrigins;
    this._enableDnsRebindingProtection = options?.enableDnsRebindingProtection ?? false;
  }

  /**
   * Starts the transport. This is required by the Transport interface but is a no-op
   * for the Streamable HTTP transport as connections are managed per-request.
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  /**
   * Validates request headers for DNS rebinding protection.
   * @returns Error message if validation fails, undefined if validation passes.
   */
  private validateRequestHeaders(req: IncomingMessage): string | undefined {
    // Skip validation if protection is not enabled
    if (!this._enableDnsRebindingProtection) {
      return undefined;
    }

    // Validate Host header if allowedHosts is configured
    if (this._allowedHosts && this._allowedHosts.length > 0) {
      const hostHeader = req.headers.host;
      if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {
        return `Invalid Host header: ${hostHeader}`;
      }
    }

    // Validate Origin header if allowedOrigins is configured
    if (this._allowedOrigins && this._allowedOrigins.length > 0) {
      const originHeader = req.headers.origin;
      if (!originHeader || !this._allowedOrigins.includes(originHeader)) {
        return `Invalid Origin header: ${originHeader}`;
      }
    }

    return undefined;
  }

  /**
   * Handles an incoming HTTP request, whether GET or POST
   */
  async handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    // Validate request headers for DNS rebinding protection
    const validationError = this.validateRequestHeaders(req);
    if (validationError) {
      res.writeHead(403).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: validationError
        },
        id: null
      }));
      this.onerror?.(new Error(validationError));
      return;
    }

    if (req.method === "POST") {
      await this.handlePostRequest(req, res, parsedBody);
    } else if (req.method === "GET") {
      await this.handleGetRequest(req, res);
    } else if (req.method === "DELETE") {
      await this.handleDeleteRequest(req, res);
    } else {
      await this.handleUnsupportedRequest(res);
    }
  }

  /**
   * Handles GET requests for SSE stream
   */
  private async handleGetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The client MUST include an Accept header, listing text/event-stream as a supported content type.
    const acceptHeader = req.headers.accept;
    if (!acceptHeader?.includes("text/event-stream")) {
      res.writeHead(406).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Not Acceptable: Client must accept text/event-stream"
        },
        id: null
      }));
      return;
    }

    // Session validation now handled by server through protocol layer
    if (!this.validateProtocolVersion(req, res)) {
      return;
    }
    // Handle resumability: check for Last-Event-ID header
    if (this._eventStore) {
      const lastEventId = req.headers['last-event-id'] as string | undefined;
      if (lastEventId) {
        await this.replayEvents(lastEventId, res);
        return;
      }
    }

    // The server MUST either return Content-Type: text/event-stream in response to this HTTP GET,
    // or else return HTTP 405 Method Not Allowed
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    };

    // After initialization, always include the session ID if we have one
    if (this.sessionId !== undefined) {
      headers["mcp-session-id"] = this.sessionId;
    }

    // Check if there's already an active standalone SSE stream for this session
    if (this._streamMapping.get(this._standaloneSseStreamId) !== undefined) {
      // Only one GET SSE stream is allowed per session
      res.writeHead(409).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Conflict: Only one SSE stream is allowed per session"
        },
        id: null
      }));
      return;
    }

    // We need to send headers immediately as messages will arrive much later,
    // otherwise the client will just wait for the first message
    res.writeHead(200, headers).flushHeaders();

    // Assign the response to the standalone SSE stream
    this._streamMapping.set(this._standaloneSseStreamId, res);
    // Set up close handler for client disconnects
    res.on("close", () => {
      this._streamMapping.delete(this._standaloneSseStreamId);
    });
  }

  /**
   * Replays events that would have been sent after the specified event ID
   * Only used when resumability is enabled
   */
  private async replayEvents(lastEventId: string, res: ServerResponse): Promise<void> {
    if (!this._eventStore) {
      return;
    }
    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      };

      if (this.sessionId !== undefined) {
        headers["mcp-session-id"] = this.sessionId;
      }
      res.writeHead(200, headers).flushHeaders();

      const streamId = await this._eventStore?.replayEventsAfter(lastEventId, {
        send: async (eventId: string, message: JSONRPCMessage) => {
          if (!this.writeSSEEvent(res, message, eventId)) {
            this.onerror?.(new Error("Failed replay events"));
            res.end();
          }
        }
      });
      this._streamMapping.set(streamId, res);
    } catch (error) {
      this.onerror?.(error as Error);
    }
  }

  /**
   * Writes an event to the SSE stream with proper formatting
   */
  private writeSSEEvent(res: ServerResponse, message: JSONRPCMessage, eventId?: string): boolean {
    let eventData = `event: message\n`;
    // Include event ID if provided - this is important for resumability
    if (eventId) {
      eventData += `id: ${eventId}\n`;
    }
    eventData += `data: ${JSON.stringify(message)}\n\n`;

    return res.write(eventData);
  }

  /**
   * Handles unsupported requests (PUT, PATCH, etc.)
   */
  private async handleUnsupportedRequest(res: ServerResponse): Promise<void> {
    res.writeHead(405, {
      "Allow": "GET, POST, DELETE"
    }).end(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    }));
  }

  /**
   * Handles POST requests containing JSON-RPC messages
   */
  private async handlePostRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    try {
      // Validate protocol version first
      if (!this.validateProtocolVersion(req, res)) {
        return;
      }
      
      // Validate the Accept header
      const acceptHeader = req.headers.accept;
      // The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
      if (!acceptHeader?.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
        res.writeHead(406).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept both application/json and text/event-stream"
          },
          id: null
        }));
        return;
      }

      const ct = req.headers["content-type"];
      if (!ct || !ct.includes("application/json")) {
        res.writeHead(415).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Unsupported Media Type: Content-Type must be application/json"
          },
          id: null
        }));
        return;
      }

      const authInfo: AuthInfo | undefined = req.auth;
      const requestInfo: RequestInfo = { headers: req.headers };

      let rawMessage;
      if (parsedBody !== undefined) {
        rawMessage = parsedBody;
      } else {
        const parsedCt = contentType.parse(ct);
        const body = await getRawBody(req, {
          limit: MAXIMUM_MESSAGE_SIZE,
          encoding: parsedCt.parameters.charset ?? "utf-8",
        });
        rawMessage = JSON.parse(body.toString());
      }

      let messages: JSONRPCMessage[];

      // handle batch and single messages
      if (Array.isArray(rawMessage)) {
        messages = rawMessage.map(msg => JSONRPCMessageSchema.parse(msg));
      } else {
        messages = [JSONRPCMessageSchema.parse(rawMessage)];
      }

      // Inject sessionId from HTTP headers into protocol messages (for backward compatibility)
      const headerSessionId = req.headers["mcp-session-id"];
      if (headerSessionId && !Array.isArray(headerSessionId)) {
        // Check for sessionId mismatches first
        for (const message of messages) {
          if ('sessionId' in message && message.sessionId !== undefined) {
            if (message.sessionId !== headerSessionId) {
              // SessionId mismatch between header and protocol message
              res.writeHead(400).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: SessionId mismatch between header and protocol message"
                },
                id: null
              }));
              return; // Fail entire request
            }
          }
        }
        
        // No mismatches, proceed with injection
        messages = messages.map(message => {
          // Inject header sessionId if message doesn't have one
          if (!('sessionId' in message) || message.sessionId === undefined) {
            return { ...message, sessionId: headerSessionId };
          }
          return message; // Keep existing sessionId
        });
      }

      // Count initialization requests for validation
      const initRequests = messages.filter(isInitializeRequest);
      
      // Check for multiple initialization requests in batch
      if (initRequests.length > 1) {
        res.writeHead(400).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Only one initialization request is allowed per batch"
          },
          id: null
        }));
        return;
      }

      // Process initialization messages first to create session state before SSE headers
      const processedInitMessages = new Set<string>();
      for (const message of messages) {
        if (isInitializeRequest(message)) {
          // Use synchronous initialization handler if available for immediate error detection
          if (this._initializeHandler && isJSONRPCRequest(message)) {
            try {
              // Check if already initialized
              if (this._sessionState) {
                res.writeHead(400).end(JSON.stringify({
                  jsonrpc: "2.0",
                  error: {
                    code: -32600,
                    message: "Server already initialized"
                  },
                  id: message.id
                }));
                return;
              }
              
              // Both type guards ensure message is InitializeRequest with id
              const result = await this._initializeHandler(message);
              // Create the response message and mark it as processed
              const response = {
                jsonrpc: "2.0" as const,
                id: message.id,
                result
              };
              processedInitMessages.add(JSON.stringify(message));
              // Store the response to send later via SSE
              this._pendingInitResponse = response;
            } catch (error) {
              // Initialization failed - return HTTP error immediately
              const errorMessage = error instanceof Error ? error.message : String(error);
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end(`Session initialization failed: ${errorMessage}`);
              return;
            }
          } else {
            // Fallback to async processing via onmessage
            await Promise.resolve(this.onmessage?.(message, { authInfo, requestInfo }));
            processedInitMessages.add(JSON.stringify(message));
            
            // Check if session initialization failed (callback threw)
            if (this._sessionState?.callbackError) {
              res.writeHead(400, { "Content-Type": "text/plain" });
              res.end(`Session initialization failed: ${this._sessionState.callbackError.message}`);
              return;
            }
          }
        }
      }
      // Session should now be created and available for HTTP headers

      // Validate session for non-initialization requests (backward compatibility for HTTP transport)
      // This provides appropriate HTTP status codes before starting SSE stream
      const sessionsEnabled = this._legacySessionCallbacks?.sessionIdGenerator !== undefined;
      if (sessionsEnabled) {
        // Sessions are enabled, validate for non-initialization requests
        // Skip messages that have already been processed as initialization
        for (const message of messages) {
          const messageStr = JSON.stringify(message);
          if (isJSONRPCRequest(message) && !isInitializeRequest(message) && !processedInitMessages.has(messageStr)) {
            const messageSessionId = message.sessionId;
            
            // Check if session ID is missing when required
            if (!messageSessionId) {
              res.writeHead(400).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: Session ID required"
                },
                id: null
              }));
              return;
            }
            
            // Check if server is not initialized yet
            if (!this._sessionState) {
              res.writeHead(400).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: Server not initialized"
                },
                id: null
              }));
              return;
            }
            
            // Check if we have an active session and validate the ID
            if (messageSessionId !== this._sessionState.sessionId) {
              res.writeHead(404).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32001,
                  message: "Session not found"
                },
                id: null
              }));
              return;
            }
            
            // If no session exists yet but sessionId was provided, it's invalid
            if (!this._sessionState) {
              res.writeHead(404).end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32001,
                  message: "Session not found"
                },
                id: null
              }));
              return;
            }
          }
        }
      }

      // check if it contains requests
      const hasRequests = messages.some(isJSONRPCRequest);

      if (!hasRequests) {
        // if it only contains notifications or responses, return 202
        res.writeHead(202).end();

        // handle each message
        for (const message of messages) {
          this.onmessage?.(message, { authInfo, requestInfo });
        }
      } else {
        // The default behavior is to use SSE streaming
        // but in some cases server will return JSON responses
        const streamId = randomUUID();
        if (!this._enableJsonResponse) {
          const headers: Record<string, string> = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          };

          // After initialization, always include the session ID if we have one
          if (this.sessionId !== undefined) {
            headers["mcp-session-id"] = this.sessionId;
          }
          res.writeHead(200, headers);
        }
        // Store the response for this request to send messages back through this connection
        // We need to track by request ID to maintain the connection
        for (const message of messages) {
          if (isJSONRPCRequest(message)) {
            this._streamMapping.set(streamId, res);
            this._requestToStreamMapping.set(message.id, streamId);
          }
        }
        // Set up close handler for client disconnects
        res.on("close", () => {
          this._streamMapping.delete(streamId);
        });

        // Send pending initialization response if we have one
        if (this._pendingInitResponse) {
          await this.send(this._pendingInitResponse);
          this._pendingInitResponse = undefined;
        }

        // handle each message (skip already processed initialization messages)
        for (const message of messages) {
          const messageStr = JSON.stringify(message);
          if (processedInitMessages.has(messageStr)) {
            continue;
          }
          this.onmessage?.(message, { authInfo, requestInfo });
        }
        // The server SHOULD NOT close the SSE stream before sending all JSON-RPC responses
        // This will be handled by the send() method when responses are ready
      }
    } catch (error) {
      // return JSON-RPC formatted error
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error",
          data: String(error)
        },
        id: null
      }));
      this.onerror?.(error as Error);
    }
  }

  /**
   * Handles DELETE requests to terminate sessions 
   * 
   * Note: backward compatibility. Handler delegates via a SessionTerminateRequest message to the server
   */
  private async handleDeleteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.validateProtocolVersion(req, res)) {
      return;
    }
    
    // Extract sessionId from header and convert to session/terminate protocol message
    const headerSessionId = req.headers["mcp-session-id"];
    if (!headerSessionId || Array.isArray(headerSessionId)) {
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Mcp-Session-Id header required for session termination"
        },
        id: null
      }));
      return;
    }

    // Validate session exists before attempting termination (HTTP transport backward compatibility)
    if (this._sessionState) {
      if (headerSessionId !== this._sessionState.sessionId) {
        res.writeHead(404).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found"
          },
          id: null
        }));
        return;
      }
    }

    // Use synchronous termination handler if available for immediate error detection
    if (this._terminateHandler) {
      try {
        await this._terminateHandler(headerSessionId);
        // Success
        res.writeHead(200).end();
      } catch (error) {
        // Termination failed - return HTTP error immediately
        const errorMessage = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Session termination failed: ${errorMessage}`);
        return;
      }
    } else {
      // Fallback to async processing via onmessage
      // Create session/terminate protocol message
      const terminateMessage: JSONRPCMessage = {
        jsonrpc: "2.0",
        id: Date.now(), // Simple ID for internal message
        method: "session/terminate",
        sessionId: headerSessionId
      };

      // Send to server for processing (server handles validation and termination)
      await Promise.resolve(this.onmessage?.(terminateMessage, { 
        requestInfo: { headers: req.headers }
      }));
      
      // Check if termination failed (onsessionclosed threw)
      if (this._sessionState?.callbackError) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Session termination failed: ${this._sessionState.callbackError.message}`);
        return;
      }
      
      // Success
      res.writeHead(200).end();
    }
  }

  // Session validation now handled entirely by server through protocol layer

  private validateProtocolVersion(req: IncomingMessage, res: ServerResponse): boolean {
    let protocolVersion = req.headers["mcp-protocol-version"] ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
    if (Array.isArray(protocolVersion)) {
      protocolVersion = protocolVersion[protocolVersion.length - 1];
    }

    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`
        },
        id: null
      }));
      return false;
    }
    return true;
  }

  async close(): Promise<void> {
    // Close all SSE connections
    this._streamMapping.forEach((response) => {
      response.end();
    });
    this._streamMapping.clear();

    // Clear any pending responses
    this._requestResponseMap.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
    let requestId = options?.relatedRequestId;
    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      // If the message is a response, use the request ID from the message
      requestId = message.id;
    }

    // Check if this message should be sent on the standalone SSE stream (no request ID)
    // Ignore notifications from tools (which have relatedRequestId set)
    // Those will be sent via dedicated response SSE streams
    
    if (requestId === undefined) {
      // For standalone SSE streams, we can only send requests and notifications
      if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
        throw new Error("Cannot send a response on a standalone SSE stream unless resuming a previous client request");
      }
      const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId)
      if (standaloneSse === undefined) {
        // The spec says the server MAY send messages on the stream, so it's ok to discard if no stream
        return;
      }

      // Generate and store event ID if event store is provided
      let eventId: string | undefined;
      if (this._eventStore) {
        // Stores the event and gets the generated event ID
        eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message);
      }

      // Send the message to the standalone SSE stream
      this.writeSSEEvent(standaloneSse, message, eventId);
      return;
    }

    // Get the response for this request
    const streamId = this._requestToStreamMapping.get(requestId);
    const response = this._streamMapping.get(streamId!);
    if (!streamId) {
      throw new Error(`No connection established for request ID: ${String(requestId)}`);
    }

    if (!this._enableJsonResponse) {
      // For SSE responses, generate event ID if event store is provided
      let eventId: string | undefined;

      if (this._eventStore) {
        eventId = await this._eventStore.storeEvent(streamId, message);
      }
      if (response) {
        // Write the event to the response stream
        this.writeSSEEvent(response, message, eventId);
      }
    }

    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      this._requestResponseMap.set(requestId, message);
      const relatedIds = Array.from(this._requestToStreamMapping.entries())
        .filter(([_, streamId]) => this._streamMapping.get(streamId) === response)
        .map(([id]) => id);

      // Check if we have responses for all requests using this connection
      const allResponsesReady = relatedIds.every(id => this._requestResponseMap.has(id));

      if (allResponsesReady) {
        if (!response) {
          throw new Error(`No connection established for request ID: ${String(requestId)}`);
        }
        if (this._enableJsonResponse) {
          // All responses ready, send as JSON
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          const sessionId = this.sessionId;
          if (sessionId !== undefined) {
            headers['mcp-session-id'] = sessionId;
          }

          const responses = relatedIds
            .map(id => this._requestResponseMap.get(id)!);

          response.writeHead(200, headers);
          if (responses.length === 1) {
            response.end(JSON.stringify(responses[0]));
          } else {
            response.end(JSON.stringify(responses));
          }
        } else {
          // End the SSE stream
          response.end();
        }
        // Clean up
        for (const id of relatedIds) {
          this._requestResponseMap.delete(id);
          this._requestToStreamMapping.delete(id);
        }
      }
    }
  }
}

