import type { Server as HttpServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Transport } from '../shared/transport.js';
import {
    JSONRPCMessage,
    JSONRPCMessageSchema,
    type MessageExtraInfo
} from '../types.js';

const SUBPROTOCOL = 'mcp';

export interface WebSocketServerTransportOptions {
    /**
     * Optional existing HTTP(S) server to attach the WebSocket server to.
     * If provided, `port` and `host` are ignored.
     */
    server?: HttpServer;

    /**
     * Port to listen on if no HTTP server is provided.
     * Defaults to 0 (OS picks a free port).
     */
    port?: number;

    /**
     * Host to bind to when creating a standalone WebSocket server.
     */
    host?: string;

    /**
     * Optional path for the WebSocket endpoint, e.g. "/mcp".
     */
    path?: string;
}

/**
 * Server transport for WebSocket: this communicates with an MCP client
 * over the WebSocket protocol.
 *
 * This is the WebSocket analogue of StdioServerTransport: it expects
 * exactly one client per transport instance and delivers JSON-RPC
 * messages via the Transport interface.
 */
export class WebSocketServerTransport implements Transport {
    private _wss: WebSocketServer;
    private _socket?: WebSocket;
    private _started = false;

    // Transport interface fields / callbacks
    sessionId?: string;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    setProtocolVersion?: (version: string) => void;

    constructor(options: WebSocketServerTransportOptions = {}) {
        const { server, port, host, path } = options;

        this._wss = new WebSocketServer({
            server,
            port: server ? undefined : (port ?? 0),
            host: server ? undefined : host,
            path,
            handleProtocols: (protocols /* , req */) => {
                // Require the MCP subprotocol if offered
                if (protocols.has(SUBPROTOCOL)) {
                    return SUBPROTOCOL;
                }
                // Reject if the client doesn't offer the MCP subprotocol
                return false;
            }
        });
    }

    /**
     * Starts listening for a single WebSocket client and sets up MCP message handling.
     *
     * Resolves once a client connects successfully.
     */
    start(): Promise<void> {
        if (this._started) {
            throw new Error(
                'WebSocketServerTransport already started! If using Server class, note that connect() calls start() automatically.'
            );
        }

        this._started = true;

        return new Promise((resolve, reject) => {
            const handleError = (err: Error) => {
                this._wss.off('connection', handleConnection);
                this.onerror?.(err);
                reject(err);
            };

            const handleConnection = (socket: WebSocket) => {
                // Only allow one client per transport instance
                if (this._socket) {
                    socket.close(1013, 'Only one client is allowed per transport');
                    return;
                }

                // Enforce negotiated subprotocol
                if (socket.protocol !== SUBPROTOCOL) {
                    socket.close(1002, 'MCP subprotocol (mcp) required');
                    return;
                }

                this._socket = socket;

                socket.on('message', data => {
                    try {
                        const parsed = JSON.parse(data.toString());
                        const message = JSONRPCMessageSchema.parse(parsed);
                        this.onmessage?.(message);
                    } catch (error) {
                        this.onerror?.(error as Error);
                    }
                });

                socket.on('error', err => {
                    this.onerror?.(err as Error);
                });

                socket.on('close', () => {
                    this._socket = undefined;
                    this.onclose?.();
                });

                this._wss.off('error', handleError);
                this._wss.off('connection', handleConnection);
                resolve();
            };

            this._wss.on('connection', handleConnection);
            this._wss.once('error', handleError);
        });
    }

    /**
     * Sends a JSON-RPC message to the connected WebSocket client.
     */
    send(message: JSONRPCMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
                const error = new Error('Not connected');
                this.onerror?.(error);
                reject(error);
                return;
            }

            const payload = JSON.stringify(message);
            this._socket.send(payload, err => {
                if (err) {
                    this.onerror?.(err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Closes the WebSocket connection and the underlying WebSocket server.
     */
    async close(): Promise<void> {
        if (this._socket && this._socket.readyState === WebSocket.OPEN) {
            this._socket.close();
        }

        await new Promise<void>((resolve, reject) => {
            this._wss.close(err => {
                if (err) {
                    this.onerror?.(err);
                    reject(err);
                } else {
                    this.onclose?.();
                    resolve();
                }
            });
        });
    }
}
