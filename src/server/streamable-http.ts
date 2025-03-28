import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Transport } from "../shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "../types.js";
import getRawBody from "raw-body";
import contentType from "content-type";

const MAXIMUM_MESSAGE_SIZE = "4mb";

interface StreamConnection {
  response: ServerResponse;
  lastEventId?: string;
  messages: Array<{
    id: string;
    message: JSONRPCMessage;
  }>;
  // mark this connection as a response to a specific request
  requestId?: string | null;
}

/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses, with session management and message resumability.
 */
export class StreamableHTTPServerTransport implements Transport {
  private _connections: Map<string, StreamConnection> = new Map();
  private _sessionId: string;
  private _messageHistory: Map<string, {
    message: JSONRPCMessage;
    connectionId?: string; // record which connection the message should be sent to
  }> = new Map();
  private _started: boolean = false;
  private _requestConnections: Map<string, string> = new Map(); // request ID to connection ID mapping

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private _endpoint: string) {
    this._sessionId = randomUUID();
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
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // validate the session ID
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && (Array.isArray(sessionId) ? sessionId[0] : sessionId) !== this._sessionId) {
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

    if (req.method === "GET") {
      await this.handleGetRequest(req, res);
    } else if (req.method === "POST") {
      await this.handlePostRequest(req, res);
    } else if (req.method === "DELETE") {
      await this.handleDeleteRequest(req, res);
    } else {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed"
        },
        id: null
      }));
    }
  }

  /**
   * Handles GET requests to establish SSE connections
   */
  private async handleGetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // validate the Accept header
    const acceptHeader = req.headers.accept;
    if (!acceptHeader || !acceptHeader.includes("text/event-stream")) {
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

    const connectionId = randomUUID();
    const lastEventId = req.headers["last-event-id"];
    const lastEventIdStr = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Mcp-Session-Id": this._sessionId,
    });

    const connection: StreamConnection = {
      response: res,
      lastEventId: lastEventIdStr,
      messages: [],
    };

    this._connections.set(connectionId, connection);

    // if there is a Last-Event-ID, replay messages on this connection
    if (lastEventIdStr) {
      this.replayMessages(connectionId, lastEventIdStr);
    }

    res.on("close", () => {
      this._connections.delete(connectionId);
      // remove all request mappings associated with this connection
      for (const [reqId, connId] of this._requestConnections.entries()) {
        if (connId === connectionId) {
          this._requestConnections.delete(reqId);
        }
      }
      if (this._connections.size === 0) {
        this.onclose?.();
      }
    });
  }

  /**
   * Handles POST requests containing JSON-RPC messages
   */
  private async handlePostRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // validate the Accept header
      const acceptHeader = req.headers.accept;
      if (!acceptHeader || 
         (!acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream"))) {
        res.writeHead(406).end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept application/json and/or text/event-stream"
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

      const parsedCt = contentType.parse(ct);
      const body = await getRawBody(req, {
        limit: MAXIMUM_MESSAGE_SIZE,
        encoding: parsedCt.parameters.charset ?? "utf-8",
      });

      const rawMessage = JSON.parse(body.toString());
      let messages: JSONRPCMessage[];
      
      // handle batch and single messages
      if (Array.isArray(rawMessage)) {
        messages = rawMessage.map(msg => JSONRPCMessageSchema.parse(msg));
      } else {
        messages = [JSONRPCMessageSchema.parse(rawMessage)];
      }

      // check if it contains requests
      const hasRequests = messages.some(msg => 'method' in msg && 'id' in msg);
      const hasOnlyNotificationsOrResponses = messages.every(msg => 
        ('method' in msg && !('id' in msg)) || ('result' in msg || 'error' in msg));

      if (hasOnlyNotificationsOrResponses) {
        // if it only contains notifications or responses, return 202
        res.writeHead(202).end();

        // handle each message
        for (const message of messages) {
          this.onmessage?.(message);
        }
      } else if (hasRequests) {
        // if it contains requests, you can choose to return an SSE stream or a JSON response
        const useSSE = acceptHeader.includes("text/event-stream");
        
        if (useSSE) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Mcp-Session-Id": this._sessionId,
          });

          const connectionId = randomUUID();
          const connection: StreamConnection = {
            response: res,
            messages: [],
          };

          this._connections.set(connectionId, connection);

          // map each request to a connection ID
          for (const message of messages) {
            if ('method' in message && 'id' in message) {
              this._requestConnections.set(String(message.id), connectionId);
            }
            this.onmessage?.(message);
          }

          res.on("close", () => {
            this._connections.delete(connectionId);
            // remove all request mappings associated with this connection
            for (const [reqId, connId] of this._requestConnections.entries()) {
              if (connId === connectionId) {
                this._requestConnections.delete(reqId);
              }
            }
            if (this._connections.size === 0) {
              this.onclose?.();
            }
          });
        } else {
          // use direct JSON response
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": this._sessionId,
          });
          
          // handle each message
          for (const message of messages) {
            this.onmessage?.(message);
          }
          
          res.end();
        }
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
    await this.close();
    res.writeHead(200).end();
  }

  /**
   * Replays messages after the specified event ID for a specific connection
   */
  private replayMessages(connectionId: string, lastEventId: string): void {
    if (!lastEventId) return;
    
    // only replay messages that should be sent on this connection
    const messages = Array.from(this._messageHistory.entries())
      .filter(([id, { connectionId: msgConnId }]) => 
        id > lastEventId && 
        (!msgConnId || msgConnId === connectionId)) // only replay messages that are not specified to a connection or specified to the current connection
      .sort(([a], [b]) => a.localeCompare(b));

    const connection = this._connections.get(connectionId);
    if (!connection) return;

    for (const [id, { message }] of messages) {
      connection.response.write(
        `id: ${id}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
      );
    }
  }

  async close(): Promise<void> {
    for (const connection of this._connections.values()) {
      connection.response.end();
    }
    this._connections.clear();
    this._messageHistory.clear();
    this._requestConnections.clear();
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._connections.size === 0) {
      throw new Error("No active connections");
    }

    let targetConnectionId = "";
    
    // if it is a response, find the corresponding request connection
    if ('id' in message && ('result' in message || 'error' in message)) {
      const connId = this._requestConnections.get(String(message.id));
      
      // if the corresponding connection is not found, the connection may be disconnected
      if (!connId || !this._connections.has(connId)) {
        // select an available connection
        const firstConnId = this._connections.keys().next().value;
        if (firstConnId) {
          targetConnectionId = firstConnId;
        } else {
          throw new Error("No available connections");
        }
      } else {
        targetConnectionId = connId;
      }
    } else {
      // for other messages, select an available connection
      const firstConnId = this._connections.keys().next().value;
      if (firstConnId) {
        targetConnectionId = firstConnId;
      } else {
        throw new Error("No available connections");
      }
    }

    const messageId = randomUUID();
    this._messageHistory.set(messageId, { 
      message, 
      connectionId: targetConnectionId 
    });

    // keep the message history in a reasonable range
    if (this._messageHistory.size > 1000) {
      const oldestKey = Array.from(this._messageHistory.keys())[0];
      this._messageHistory.delete(oldestKey);
    }

    // send the message to all active connections
    for (const [connId, connection] of this._connections.entries()) {
      // if it is a response message, only send to the target connection
      if ('id' in message && ('result' in message || 'error' in message)) {
        if (connId === targetConnectionId) {
          connection.response.write(
            `id: ${messageId}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
          );
        }
      } else {
        // for other messages, send to all connections
        connection.response.write(
          `id: ${messageId}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
        );
      }
    }
  }

  /**
   * Returns the session ID for this transport
   */
  get sessionId(): string {
    return this._sessionId;
  }
} 