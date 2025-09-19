import { Transport } from '../shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

const SUBPROTOCOL = 'mcp';

/**
 * Client transport for WebSocket: this will connect to a server over the WebSocket protocol.
 */
export class WebSocketClientTransport implements Transport {
    private _socket?: WebSocket;
    private _url: URL;

    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    constructor(url: URL) {
        this._url = url;
    }

    start(): Promise<void> {
        if (this._socket) {
            throw new Error(
                'WebSocketClientTransport already started! If using Client class, note that connect() calls start() automatically.'
            );
        }

        return new Promise((resolve, reject) => {
            this._socket = new WebSocket(this._url, SUBPROTOCOL);

            this._socket.onerror = event => {
                const error = 'error' in event ? (event.error as Error) : new Error(`WebSocket error: ${JSON.stringify(event)}`);
                reject(error);
                this.onerror?.(error);
            };

            this._socket.onopen = () => {
                resolve();
            };

            this._socket.onclose = () => {
                this.onclose?.();
            };

            this._socket.onmessage = (event: MessageEvent) => {
                let message: JSONRPCMessage;
                try {
                    message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
                } catch (error) {
                    this.onerror?.(error as Error);
                    return;
                }

                this.onmessage?.(message);
            };
        });
    }

    async close(): Promise<void> {
        this._socket?.close();
    }

    send(message: JSONRPCMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this._socket) {
                reject(new Error('Not connected'));
                return;
            }

            this._socket?.send(JSON.stringify(message));
            resolve();
        });
    }
}
