import { IncomingMessage, ServerResponse } from "node:http";
import { Transport } from "../shared/transport.js";
import { isJSONRPCRequest, isJSONRPCResponse, JSONRPCMessage, JSONRPCMessageSchema, RequestId } from "../types.js";
import getRawBody from "raw-body";
import contentType from "content-type";
import { randomUUID } from "node:crypto";

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
  sessionIdGenerator: () => string | undefined;

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
 *  sessionId: randomUUID(),
 * });
 * 
 * // Stateless mode - explicitly set session ID to undefined
 * const statelessTransport = new StreamableHTTPServerTransport({
 *    sessionId: undefined,
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
 * - Session ID is only included in initialization responses
 * - No session validation is performed
 */
export class StreamableHTTPServerTransport implements Transport {
  // when sessionId is not set (undefined), it means the transport is in stateless mode
  private sessionIdGenerator: () => string | undefined;
  private _started: boolean = false;
  private _streamMapping: Map<string, ServerResponse> = new Map();
  private _requestToStreamMapping: Map<RequestId, string> = new Map();
  private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map();
  private _initialized: boolean = false;
  private _enableJsonResponse: boolean = false;
  private _standaloneSseStreamId: string = '_GET_stream';
  private _eventStore?: EventStore;

  sessionId?: string | undefined;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: StreamableHTTPServerTransportOptions) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this._enableJsonResponse = options.enableJsonResponse ?? false;
    this._eventStore = options.eventStore;
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
   * Handles an incoming HTTP request, whether GET or POST
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
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

    // If an Mcp-Session-Id is returned by the server during initialization,
    // clients using the Streamable HTTP transport MUST include it 
    // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
    if (!this.validateSession(req, res)) {
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
  private async handlePostRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    try {
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

      // Check if this is an initialization request
      // https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle/
      const isInitializationRequest = messages.some(
        msg => 'method' in msg && msg.method === 'initialize'
      );
      if (isInitializationRequest) {
        // If it's a server with session management and the session ID is already set we should reject the request
        // to avoid re-initialization.
        if (this._initialized) {
          res.writeHead(400).end(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: Server already initialized"
            },
            id: null
          }));
          return;
        }
        if (messages.length > 1) {
          res.writeHead(400).end(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid Request: Only one initialization request is allowed"
            },
            id: null
          }));
          return;
        }
        this.sessionId = this.sessionIdGenerator();
        this._initialized = true;

      }
      // If an Mcp-Session-Id is returned by the server during initialization,
      // clients using the Streamable HTTP transport MUST include it 
      // in the Mcp-Session-Id header on all of their subsequent HTTP requests.
      if (!isInitializationRequest && !this.validateSession(req, res)) {
        return;
      }


      // check if it contains requests
      const hasRequests = messages.some(isJSONRPCRequest);

      if (!hasRequests) {
        // if it only contains notifications or responses, return 202
        res.writeHead(202).end();

        // handle each message
        for (const message of messages) {
          this.onmessage?.(message);
        }
      } else if (hasRequests) {
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
          if ('method' in message && 'id' in message) {
            this._streamMapping.set(streamId, res);
            this._requestToStreamMapping.set(message.id, streamId);
          }
        }
        // Set up close handler for client disconnects
        res.on("close", () => {
          this._streamMapping.delete(streamId);
        });

        // handle each message
        for (const message of messages) {
          this.onmessage?.(message);
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
   */
  private async handleDeleteRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.validateSession(req, res)) {
      return;
    }
    await this.close();
    res.writeHead(200).end();
  }

  /**
   * Validates session ID for non-initialization requests
   * Returns true if the session is valid, false otherwise
   */
  private validateSession(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this._initialized) {
      // If the server has not been initialized yet, reject all requests
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Server not initialized"
        },
        id: null
      }));
      return false;
    }
    if (this.sessionId === undefined) {
      // If the session ID is not set, the session management is disabled
      // and we don't need to validate the session ID
      return true;
    }
    const sessionId = req.headers["mcp-session-id"];

    if (!sessionId) {
      // Non-initialization requests without a session ID should return 400 Bad Request
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Mcp-Session-Id header is required"
        },
        id: null
      }));
      return false;
    } else if (Array.isArray(sessionId)) {
      res.writeHead(400).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Mcp-Session-Id header must be a single value"
        },
        id: null
      }));
      return false;
    }
    else if (sessionId !== this.sessionId) {
      // Reject requests with invalid session ID with 404 Not Found
      res.writeHead(404).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found"
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
    if ('result' in message || 'error' in message) {
      // If the message is a response, use the request ID from the message
      requestId = message.id;
    }

    // Check if this message should be sent on the standalone SSE stream (no request ID)
    // Ignore notifications from tools (which have relatedRequestId set)
    // Those will be sent via dedicated response SSE streams
    if (requestId === undefined) {
      // For standalone SSE streams, we can only send requests and notifications
      if ('result' in message || 'error' in message) {
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

    if (isJSONRPCResponse(message)) {
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
          if (this.sessionId !== undefined) {
            headers['mcp-session-id'] = this.sessionId;
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

