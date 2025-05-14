import { WebSocketServer, WebSocket as WS } from 'ws';
import { AddressInfo } from 'net';
import { WebSocketClientTransport } from './websocket.js';
import { JSONRPCMessage } from '../types.js';
import { IncomingMessage } from 'http';

/**
 * Mock WebSocket implementation for testing.
 * This class simulates browser WebSocket behavior in Node.js environment.
 */
class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  private ws: WS;
  private _readyState: number;

  constructor(url: string, protocols?: string | string[]) {
    super();
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      throw new Error('Invalid WebSocket URL');
    }

    this._readyState = MockWebSocket.CONNECTING;
    this.ws = new WS(url, protocols);

    this.ws.on('open', () => {
      this._readyState = MockWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });

    this.ws.on('error', (error) => {
      this._readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(Object.assign(new Event('error'), { error }));
    });

    this.ws.on('close', () => {
      this._readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new Event('close'));
    });

    this.ws.on('message', (data) => {
      this.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  get readyState(): number {
    return this._readyState;
  }

  send(data: string): void {
    if (this._readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(data);
  }

  close(): void {
    if (this._readyState === MockWebSocket.CLOSED) {
      return;
    }
    this._readyState = MockWebSocket.CLOSING;
    this.ws.close();
  }
}

// Set up global WebSocket
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = MockWebSocket;

describe('WebSocketClientTransport', () => {
  let wss: WebSocketServer;
  let transport: WebSocketClientTransport;
  let baseUrl: URL;

  beforeEach((done) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address() as AddressInfo;
      baseUrl = new URL(`ws://localhost:${addr.port}`);
      done();
    });
  });

  afterEach(async () => {
    await transport?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  describe('connection handling', () => {
    /**
     * Tests successful WebSocket connection establishment.
     * Verifies that the client can connect to the server and the connection is properly established.
     */
    it('establishes WebSocket connection successfully', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      const connectionPromise = new Promise<void>((resolve) => {
        wss.once('connection', () => resolve());
      });

      await transport.start();
      await connectionPromise;

      expect(wss.clients.size).toBe(1);
    });

    /**
     * Tests connection failure handling.
     * Verifies that the client properly handles connection failures when the server is not available.
     */
    it('rejects if connection fails', async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      
      transport = new WebSocketClientTransport(baseUrl);
      await expect(transport.start()).rejects.toThrow();
    });

    /**
     * Tests WebSocket connection closure.
     * Verifies that the client can properly close the connection and cleanup resources.
     */
    it('closes WebSocket connection on close()', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      await transport.start();
      await new Promise<void>((resolve) => {
        wss.once('connection', () => resolve());
      });

      const closePromise = new Promise<void>((resolve) => {
        wss.clients.forEach((client) => {
          client.once('close', () => resolve());
        });
      });

      await transport.close();
      await closePromise;
    });
  });

  describe('message handling', () => {
    /**
     * Tests JSON-RPC message sending and receiving.
     * Verifies that the client can send messages to the server and receive responses correctly.
     */
    it('sends and receives JSON-RPC messages', async () => {
      const receivedMessages: JSONRPCMessage[] = [];
      transport = new WebSocketClientTransport(baseUrl);
      transport.onmessage = (msg: JSONRPCMessage) => receivedMessages.push(msg);

      await new Promise<void>((resolve) => {
        wss.once('connection', (ws: WS) => {
          ws.on('message', (data: Buffer) => {
            ws.send(data);
          });
          resolve();
        });
      });

      await transport.start();

      const testMessage: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'test',
        params: { foo: 'bar' }
      };

      await transport.send(testMessage);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(testMessage);
    });

    /**
     * Tests error handling for malformed messages.
     * Verifies that the client properly handles and reports errors when receiving invalid JSON messages.
     */
    it('handles malformed messages', async () => {
      const errors: Error[] = [];
      transport = new WebSocketClientTransport(baseUrl);
      transport.onerror = (err: Error) => errors.push(err);

      await new Promise<void>((resolve) => {
        wss.once('connection', (ws: WS) => {
          setTimeout(() => ws.send('invalid json'), 100);
          resolve();
        });
      });

      await transport.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/JSON/);
    });
  });

  describe('protocol handling', () => {
    /**
     * Tests WebSocket subprotocol handling.
     * Verifies that the client correctly negotiates and uses the MCP protocol.
     */
    it('uses correct subprotocol', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      const protocols = await new Promise<string[]>((resolve) => {
        wss.once('connection', (ws: WS, req: IncomingMessage) => {
          resolve(req.headers['sec-websocket-protocol']?.split(', ') || []);
        });
      });

      await transport.start();
      expect(protocols).toContain('mcp');
    });
  });
}); 