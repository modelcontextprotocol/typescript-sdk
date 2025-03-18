import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { JSONRPCMessage } from './types.js';
import { BrowserContextTransport } from './browser-context-transport.js';

// Mock MessageChannel and MessagePort since they're browser APIs not available in Node.js test environment
class MockMessagePort {
  onmessage: ((event: { data: any }) => void) | null = null;
  onmessageerror: ((event: any) => void) | null = null;
  
  private _otherPort?: MockMessagePort;
  private _started = false;
  private _closed = false;
  
  constructor() {}
  
  connect(otherPort: MockMessagePort) {
    this._otherPort = otherPort;
  }
  
  start() {
    this._started = true;
  }
  
  close() {
    this._closed = true;
    this._otherPort = undefined;
  }
  
  postMessage(data: any) {
    if (this._closed) {
      throw new Error('Cannot post message on closed port');
    }
    
    if (!this._started) {
      throw new Error('Cannot post message before start');
    }
    
    if (!this._otherPort) {
      throw new Error('No connected port');
    }
    
    // Simulate async message delivery
    setTimeout(() => {
      if (this._otherPort?.onmessage && !this._otherPort._closed) {
        this._otherPort.onmessage({ data });
      }
    }, 0);
  }
}

class MockMessageChannel {
  port1: MockMessagePort;
  port2: MockMessagePort;
  
  constructor() {
    this.port1 = new MockMessagePort();
    this.port2 = new MockMessagePort();
    this.port1.connect(this.port2);
    this.port2.connect(this.port1);
  }
}

// Mock iframe window and postMessage
class MockWindow {
  private eventHandlers: Record<string, Array<(event: any) => void>> = {};
  
  addEventListener(type: string, handler: (event: any) => void) {
    if (!this.eventHandlers[type]) {
      this.eventHandlers[type] = [];
    }
    this.eventHandlers[type].push(handler);
  }
  
  dispatchEvent(type: string, event: any) {
    if (this.eventHandlers[type]) {
      this.eventHandlers[type].forEach(handler => handler(event));
    }
  }
}

class MockIframe {
  contentWindow: {
    postMessage: jest.Mock;
  };
  
  constructor() {
    this.contentWindow = {
      postMessage: jest.fn()
    };
  }
}

// Mock Worker
class MockWorker {
  onmessage: ((event: { data: any }) => void) | null = null;
  postMessage: jest.Mock;
  
  constructor() {
    this.postMessage = jest.fn();
  }
  
  // Helper to simulate receiving a message
  simulateMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

// Replace global MessageChannel with our mock implementation for testing
global.MessageChannel = MockMessageChannel as any;

// Type for Jest done callback
type DoneCallback = (error?: any) => void;

describe('BrowserContextTransport', () => {
  let transport1: BrowserContextTransport;
  let transport2: BrowserContextTransport;
  let mockPort1: MockMessagePort;
  let mockPort2: MockMessagePort;
  
  beforeEach(() => {
    const channel = new MockMessageChannel();
    mockPort1 = channel.port1;
    mockPort2 = channel.port2;
    
    transport1 = new BrowserContextTransport(mockPort1 as unknown as MessagePort);
    transport2 = new BrowserContextTransport(mockPort2 as unknown as MessagePort);
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('constructor', () => {
    it('should set the sessionId', () => {
      // Check that sessionId matches the expected format (timestamp in base36-randomsuffix)
      expect(transport1.sessionId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
    
    it('should throw an error if port is not provided', () => {
      expect(() => new BrowserContextTransport(null as unknown as MessagePort)).toThrow('MessagePort is required');
    });
    
    it('should setup event listeners on the port', () => {
      expect(mockPort1.onmessage).not.toBeNull();
      expect(mockPort1.onmessageerror).not.toBeNull();
    });
  });
  
  describe('createChannelPair', () => {
    it('should create a pair of connected transports', () => {
      const [t1, t2] = BrowserContextTransport.createChannelPair();
      expect(t1).toBeInstanceOf(BrowserContextTransport);
      expect(t2).toBeInstanceOf(BrowserContextTransport);
    });
    
    it('should use the same session ID for both transports', () => {
      const [t1, t2] = BrowserContextTransport.createChannelPair();
      expect(t1.sessionId).toBe(t2.sessionId);
      expect(t1.sessionId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
  });
  
  describe('start', () => {
    it('should start the MessagePort', async () => {
      const startSpy = jest.spyOn(mockPort1, 'start');
      await transport1.start();
      expect(startSpy).toHaveBeenCalled();
    });
    
    it('should throw if already started', async () => {
      await transport1.start();
      await expect(transport1.start()).rejects.toThrow('already started');
    });
    
    it('should throw if closed', async () => {
      await transport1.close();
      await expect(transport1.start()).rejects.toThrow('closed');
    });
  });
  
  describe('send', () => {
    beforeEach(async () => {
      await transport1.start();
      await transport2.start();
    });
    
    it('should send a message through the MessagePort', async () => {
      const postMessageSpy = jest.spyOn(mockPort1, 'postMessage');
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: { hello: 'world' },
        id: 1
      };
      
      await transport1.send(message);
      expect(postMessageSpy).toHaveBeenCalledWith(message);
    });
    
    it('should throw if transport is closed', async () => {
      await transport1.close();
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'test',
        id: 2
      };
      
      await expect(transport1.send(message)).rejects.toThrow('closed');
    });
    
    it('should call onerror and reject if postMessage throws', async () => {
      const error = new Error('Test error');
      jest.spyOn(mockPort1, 'postMessage').mockImplementation(() => {
        throw error;
      });
      
      const onErrorSpy = jest.fn();
      transport1.onerror = onErrorSpy;
      
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'test',
        id: 3
      };
      
      await expect(transport1.send(message)).rejects.toThrow('Test error');
      expect(onErrorSpy).toHaveBeenCalledWith(error);
    });
  });
  
  describe('close', () => {
    it('should close the MessagePort', async () => {
      const closeSpy = jest.spyOn(mockPort1, 'close');
      await transport1.close();
      expect(closeSpy).toHaveBeenCalled();
    });
    
    it('should call onclose if defined', async () => {
      const onCloseSpy = jest.fn();
      transport1.onclose = onCloseSpy;
      await transport1.close();
      expect(onCloseSpy).toHaveBeenCalled();
    });
    
    it('should be idempotent', async () => {
      const closeSpy = jest.spyOn(mockPort1, 'close');
      await transport1.close();
      await transport1.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('message handling', () => {
    let onMessageSpy: jest.Mock;
    let onErrorSpy: jest.Mock;
    const validMessage: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'test',
      params: { foo: 'bar' },
      id: 123
    };
    
    beforeEach(async () => {
      onMessageSpy = jest.fn();
      onErrorSpy = jest.fn();
      transport1.onmessage = onMessageSpy;
      transport1.onerror = onErrorSpy;
      await transport1.start();
      await transport2.start();
    });
    
    it('should receive messages from the other transport', (done: DoneCallback) => {
      transport2.send(validMessage);
      
      // Use setTimeout to wait for the async message delivery
      setTimeout(() => {
        expect(onMessageSpy).toHaveBeenCalledWith(validMessage);
        done();
      }, 10);
    });
    
    it('should call onerror if message parsing fails', () => {
      // Manually trigger onmessage with invalid data
      mockPort1.onmessage!({ data: 'not a valid JSON-RPC message' });
      expect(onErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Failed to parse message')
      }));
    });
    
    it('should call onerror on messageerror event', () => {
      const errorEvent = { type: 'messageerror', data: 'some error' };
      mockPort1.onmessageerror!(errorEvent);
      
      expect(onErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('MessagePort error')
      }));
    });
  });
  
  describe('end-to-end test', () => {
    it('should allow bidirectional communication', (done: DoneCallback) => {
      // Define test message types based on a subset of JSONRPCMessage
      type RequestMessage = {
        jsonrpc: string;
        method: string;
        params?: Record<string, unknown>;
        id: number;
      };
      
      type ResponseMessage = {
        jsonrpc: string;
        result: Record<string, unknown>;
        id: number;
      };
      
      const messages1: ResponseMessage[] = [];
      const messages2: RequestMessage[] = [];
      
      transport1.onmessage = (msg) => {
        // Type assertion for test purposes
        messages1.push(msg as unknown as ResponseMessage);
        if (messages1.length === 3 && messages2.length === 3) {
          checkResults();
        }
      };
      
      transport2.onmessage = (msg) => {
        // Type assertion for test purposes
        messages2.push(msg as unknown as RequestMessage);
        if (messages1.length === 3 && messages2.length === 3) {
          checkResults();
        }
      };
      
      transport1.start().then(() => {
        transport2.start().then(() => {
          // Send messages from transport1 to transport2
          transport1.send({
            jsonrpc: '2.0',
            method: 'method1',
            id: 1
          });
          
          transport1.send({
            jsonrpc: '2.0',
            method: 'method2',
            params: { x: 1 },
            id: 2
          });
          
          transport1.send({
            jsonrpc: '2.0',
            method: 'method3',
            params: { array: [1, 2, 3] },
            id: 3
          });
          
          // Send messages from transport2 to transport1
          transport2.send({
            jsonrpc: '2.0',
            result: { value: 'result1' },
            id: 1
          });
          
          transport2.send({
            jsonrpc: '2.0',
            result: { value: 'result2' },
            id: 2
          });
          
          transport2.send({
            jsonrpc: '2.0',
            result: { value: 'result3' },
            id: 3
          });
        });
      });
      
      function checkResults() {
        expect(messages1.length).toBe(3);
        expect(messages2.length).toBe(3);
        
        expect(messages1.map(m => m.id)).toEqual([1, 2, 3]);
        expect(messages2.map(m => m.id)).toEqual([1, 2, 3]);
        
        expect(messages1.every(m => 'result' in m)).toBe(true);
        expect(messages2.every(m => 'method' in m)).toBe(true);
        
        done();
      }
    });
  });
  
  describe('iframe integration', () => {
    let mockIframe: MockIframe;
    let mockMainWindow: MockWindow;
    let channel: MockMessageChannel;
    let parentTransport: BrowserContextTransport;
    
    beforeEach(() => {
      // Setup parent window context
      mockIframe = new MockIframe();
      mockMainWindow = new MockWindow();
      channel = new MockMessageChannel();
      
      // Create transport in parent window
      parentTransport = new BrowserContextTransport(channel.port1 as unknown as MessagePort);
    });
    
    it('should verify the iframe example from README works correctly', (done: DoneCallback) => {
      // This test verifies the pattern shown in the README
      
      // 1. Parent context creates channel and transport
      expect(parentTransport).toBeInstanceOf(BrowserContextTransport);
      
      // 2. Parent sends port2 to iframe
      mockIframe.contentWindow.postMessage('init', '*', [channel.port2]);
      expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith('init', '*', [channel.port2]);
      
      // 3. Setup message handler in iframe
      const testMessage: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'hello',
        id: 123
      };
      
      // Simulate iframe receiving message with port
      setTimeout(() => {
        // In real code, this would be an event listener in the iframe
        const iframeTransport = new BrowserContextTransport(channel.port2 as unknown as MessagePort);
        
        let iframeReceivedMessage = false;
        iframeTransport.onmessage = (msg) => {
          expect(msg).toEqual(testMessage);
          iframeReceivedMessage = true;
          
          // Test bidirectional communication
          const response: JSONRPCMessage = {
            jsonrpc: '2.0',
            result: { status: 'success' },
            id: 123
          };
          
          iframeTransport.send(response);
        };
        
        iframeTransport.start().then(() => {
          // Setup parent transport to receive messages
          let parentReceivedResponse = false;
          parentTransport.onmessage = (msg) => {
            expect(msg).toEqual({
              jsonrpc: '2.0',
              result: { status: 'success' },
              id: 123
            });
            parentReceivedResponse = true;
            
            // Verify bidirectional communication worked
            setTimeout(() => {
              expect(iframeReceivedMessage).toBe(true);
              expect(parentReceivedResponse).toBe(true);
              done();
            }, 10);
          };
          
          parentTransport.start().then(() => {
            // Send message from parent to iframe
            parentTransport.send(testMessage);
          });
        });
      }, 10);
    });
  });
  
  describe('worker integration', () => {
    let mockWorker: MockWorker;
    let channel: MockMessageChannel;
    let mainThreadTransport: BrowserContextTransport;
    
    beforeEach(() => {
      // Setup main thread context
      mockWorker = new MockWorker();
      channel = new MockMessageChannel();
      
      // Create transport in main thread
      mainThreadTransport = new BrowserContextTransport(channel.port1 as unknown as MessagePort);
    });
    
    it('should verify the worker example from README works correctly', (done: DoneCallback) => {
      // This test verifies the pattern shown in the README
      
      // 1. Main thread creates channel and transport
      expect(mainThreadTransport).toBeInstanceOf(BrowserContextTransport);
      
      // 2. Main thread sends port2 to worker
      mockWorker.postMessage('init', [channel.port2]);
      expect(mockWorker.postMessage).toHaveBeenCalledWith('init', [channel.port2]);
      
      // 3. Setup message handler in worker (simulated)
      const testMessage: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'compute',
        params: { data: [1, 2, 3] },
        id: 456
      };
      
      // Simulate worker receiving message with port
      setTimeout(() => {
        // In real code, this would be an event listener in the worker
        const workerTransport = new BrowserContextTransport(channel.port2 as unknown as MessagePort);
        
        let workerReceivedMessage = false;
        workerTransport.onmessage = (msg) => {
          expect(msg).toEqual(testMessage);
          workerReceivedMessage = true;
          
          // Test bidirectional communication
          const response: JSONRPCMessage = {
            jsonrpc: '2.0',
            result: { computed: 6 },
            id: 456
          };
          
          workerTransport.send(response);
        };
        
        workerTransport.start().then(() => {
          // Setup main thread transport to receive messages
          let mainThreadReceivedResponse = false;
          mainThreadTransport.onmessage = (msg) => {
            expect(msg).toEqual({
              jsonrpc: '2.0',
              result: { computed: 6 },
              id: 456
            });
            mainThreadReceivedResponse = true;
            
            // Verify bidirectional communication worked
            setTimeout(() => {
              expect(workerReceivedMessage).toBe(true);
              expect(mainThreadReceivedResponse).toBe(true);
              done();
            }, 10);
          };
          
          mainThreadTransport.start().then(() => {
            // Send message from main thread to worker
            mainThreadTransport.send(testMessage);
          });
        });
      }, 10);
    });
  });
}); 