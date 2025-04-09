import { WebSocketServer, WebSocket as WS } from 'ws';
import { AddressInfo } from 'net';
import { WebSocketClientTransport } from './websocket.js';
import { JSONRPCMessage } from '../types.js';
import { IncomingMessage } from 'http';

// Global type declarations
declare global {
  interface Window {
    MessageEvent: typeof MessageEvent;
    WebSocket: typeof WebSocket;
  }
}

// Mock browser WebSocket
class MockWebSocket extends EventTarget {
  private ws: WS;
  private url: string;
  private protocol: string;
  private readyState: number = MockWebSocket.CONNECTING;
  private _onopen: ((event: Event) => void) | null = null;
  private _onclose: ((event: Event) => void) | null = null;
  private _onerror: ((event: Event & { error?: Error }) => void) | null = null;
  private _onmessage: ((event: MessageEvent) => void) | null = null;

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  constructor(url: string, protocol: string) {
    super();
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      throw new Error('Invalid WebSocket URL');
    }
    this.url = url;
    this.protocol = protocol;
    this.ws = new WS(url, protocol);

    this.ws.on('open', () => {
      this.readyState = MockWebSocket.OPEN;
      const event = new Event('open');
      this.dispatchEvent(event);
      this._onopen?.(event);
    });

    this.ws.on('error', (error) => {
      this.readyState = MockWebSocket.CLOSED;
      const event = Object.assign(new Event('error'), { error });
      this.dispatchEvent(event);
      this._onerror?.(event);
    });

    this.ws.on('close', () => {
      this.readyState = MockWebSocket.CLOSED;
      const event = new Event('close');
      this.dispatchEvent(event);
      this._onclose?.(event);
    });

    this.ws.on('message', (data) => {
      const event = Object.assign(new MessageEvent('message'), { data });
      this.dispatchEvent(event);
      this._onmessage?.(event);
    });
  }

  set onopen(handler: ((event: Event) => void) | null) {
    this._onopen = handler;
  }

  set onerror(handler: ((event: Event & { error?: Error }) => void) | null) {
    this._onerror = handler;
  }

  set onclose(handler: ((event: Event) => void) | null) {
    this._onclose = handler;
  }

  set onmessage(handler: ((event: MessageEvent) => void) | null) {
    this._onmessage = handler;
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    this.ws.close();
  }
}

// Set WebSocket as global
(global as any).WebSocket = MockWebSocket;
(global as any).MessageEvent = class MessageEvent extends Event {
  data?: any;
  constructor(type: string, init?: { data?: any }) {
    super(type);
    this.data = init?.data;
  }
};
(global as any).Event = Event;

describe('WebSocketClientTransport', () => {
  let wss: WebSocketServer;
  let transport: WebSocketClientTransport;
  let baseUrl: URL;

  beforeEach((done) => {
    // Create WebSocket server with random port
    wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address() as AddressInfo;
      baseUrl = new URL(`ws://localhost:${addr.port}`);
      done();
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Clean up resources and event listeners
    wss.removeAllListeners();
    await transport?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    jest.clearAllMocks();
  });

  describe('connection handling', () => {
    it('establishes WebSocket connection successfully', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      // Wait for connection
      const connectionPromise = new Promise<void>((resolve) => {
        wss.once('connection', () => resolve());
      });

      await transport.start();
      await connectionPromise;

      // Verify connection
      expect(wss.clients.size).toBe(1);
    }, 10000);

    it('rejects if connection fails', async () => {
      // Close server before attempting connection
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      
      transport = new WebSocketClientTransport(baseUrl);
      await expect(transport.start()).rejects.toThrow();
    }, 10000);

    it('closes WebSocket connection on close()', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      // Wait for connection
      const connectionPromise = new Promise<void>((resolve) => {
        wss.once('connection', () => resolve());
      });

      await transport.start();
      await connectionPromise;

      // Wait for close event
      const closePromise = new Promise<void>((resolve) => {
        wss.clients.forEach((client) => {
          client.once('close', () => resolve());
        });
      });

      // Close connection
      await transport.close();
      await closePromise;
    }, 10000);
  });

  describe('message handling', () => {
    it('sends and receives JSON-RPC messages', async () => {
      const receivedMessages: JSONRPCMessage[] = [];
      transport = new WebSocketClientTransport(baseUrl);
      transport.onmessage = (msg: JSONRPCMessage) => receivedMessages.push(msg);

      // Wait for connection and setup echo
      const connectionPromise = new Promise<void>((resolve) => {
        wss.once('connection', (ws: WS) => {
          ws.on('message', (data: Buffer) => {
            ws.send(data);
          });
          resolve();
        });
      });

      await transport.start();
      await connectionPromise;

      // Send test message
      const testMessage: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'test',
        params: { foo: 'bar' }
      };
      await transport.send(testMessage);

      // Wait for message processing
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify message received
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(testMessage);
    }, 10000);

    it('handles malformed messages', async () => {
      const errors: Error[] = [];
      transport = new WebSocketClientTransport(baseUrl);
      transport.onerror = (err: Error) => errors.push(err);

      // Wait for connection
      const connectionPromise = new Promise<void>((resolve) => {
        wss.once('connection', (ws: WS) => {
          resolve();
          // Send invalid message after a short delay
          setTimeout(() => {
            ws.send('invalid json');
          }, 100);
        });
      });

      await transport.start();
      await connectionPromise;

      // Wait for error processing
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verify error handling
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/JSON/);
    }, 10000);
  });

  describe('protocol handling', () => {
    it('uses correct subprotocol', async () => {
      transport = new WebSocketClientTransport(baseUrl);
      
      // Wait for connection and get protocols
      const connectionPromise = new Promise<string[]>((resolve) => {
        wss.once('connection', (ws: WS, req: IncomingMessage) => {
          resolve(req.headers['sec-websocket-protocol']?.split(', ') || []);
        });
      });

      await transport.start();
      const protocols = await connectionPromise;

      // Verify MCP protocol is used
      expect(protocols).toContain('mcp');
    }, 10000);
  });
}); 