import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { JSONRPCMessage } from './types.js';
import { BrowserContextTransport } from './browser-context-transport.js';

// Mock MessageChannel and MessagePort since they're browser APIs not available in Node.js test environment
class MockMessagePort {
  onmessage: ((event: { data: JSONRPCMessage | unknown }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  
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
  
  postMessage(data: JSONRPCMessage) {
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
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage: jest.Mock;
  
  constructor() {
    this.postMessage = jest.fn();
  }
  
  // Helper to simulate receiving a message
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }
}

// Replace global MessageChannel with our mock implementation for testing
global.MessageChannel = MockMessageChannel as unknown as typeof MessageChannel;

describe('BrowserContextTransport', () => {
  let transport1: BrowserContextTransport;
  let transport2: BrowserContextTransport;
  let mockPort1: MockMessagePort;
  let mockPort2: MockMessagePort;
  
  beforeEach(() => {
    // Arrange - Global setup for most tests
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
    it('should generate a valid session ID in the expected format', () => {
      // Arrange - Handled in beforeEach
      
      // Act - Constructor already called in beforeEach
      
      // Assert
      expect(transport1.sessionId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
    
    it('should throw an error when port is not provided', () => {
      // Arrange
      
      // Act & Assert - Combine for exception testing
      expect(() => new BrowserContextTransport(null as unknown as MessagePort)).toThrow('MessagePort is required');
    });
    
    it('should set up event listeners on the provided MessagePort', () => {
      // Arrange - Handled in beforeEach
      
      // Act - Constructor already called in beforeEach
      
      // Assert
      expect(mockPort1.onmessage).not.toBeNull();
      expect(mockPort1.onmessageerror).not.toBeNull();
    });
  });
  
  describe('createChannelPair static method', () => {
    it('should create two connected BrowserContextTransport instances', () => {
      // Arrange
      
      // Act
      const [t1, t2] = BrowserContextTransport.createChannelPair();
      
      // Assert
      expect(t1).toBeInstanceOf(BrowserContextTransport);
      expect(t2).toBeInstanceOf(BrowserContextTransport);
    });
    
    it('should assign the same session ID to both transport instances', () => {
      // Arrange
      
      // Act
      const [t1, t2] = BrowserContextTransport.createChannelPair();
      
      // Assert
      expect(t1.sessionId).toBe(t2.sessionId);
      expect(t1.sessionId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
  });
  
  describe('start method', () => {
    it('should call start on the underlying MessagePort', async () => {
      // Arrange
      const startSpy = jest.spyOn(mockPort1, 'start');
      
      // Act
      await transport1.start();
      
      // Assert
      expect(startSpy).toHaveBeenCalled();
    });
    
    it('should reject when called multiple times on the same transport', async () => {
      // Arrange
      await transport1.start();
      
      // Act & Assert
      await expect(transport1.start()).rejects.toThrow('already started');
    });
    
    it('should reject when called on a closed transport', async () => {
      // Arrange
      await transport1.close();
      
      // Act & Assert
      await expect(transport1.start()).rejects.toThrow('closed');
    });
  });
  
  describe('send method', () => {
    beforeEach(async () => {
      // Additional setup for send tests
      await transport1.start();
      await transport2.start();
    });
    
    it('should forward messages to the underlying MessagePort', async () => {
      // Arrange
      const postMessageSpy = jest.spyOn(mockPort1, 'postMessage');
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: { hello: 'world' },
        id: 1
      };
      
      // Act
      await transport1.send(message);
      
      // Assert
      expect(postMessageSpy).toHaveBeenCalledWith(message);
    });
    
    it('should reject when sending messages on a closed transport', async () => {
      // Arrange
      await transport1.close();
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'test',
        id: 2
      };
      
      // Act & Assert
      await expect(transport1.send(message)).rejects.toThrow('closed');
    });
    
    it('should call onerror handler and reject when underlying postMessage throws', async () => {
      // Arrange
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
      
      // Act & Assert
      await expect(transport1.send(message)).rejects.toThrow('Test error');
      expect(onErrorSpy).toHaveBeenCalledWith(error);
    });
  });
  
  describe('close method', () => {
    it('should call close on the underlying MessagePort', async () => {
      // Arrange
      const closeSpy = jest.spyOn(mockPort1, 'close');
      
      // Act
      await transport1.close();
      
      // Assert
      expect(closeSpy).toHaveBeenCalled();
    });
    
    it('should trigger the onclose callback when defined', async () => {
      // Arrange
      const onCloseSpy = jest.fn();
      transport1.onclose = onCloseSpy;
      
      // Act
      await transport1.close();
      
      // Assert
      expect(onCloseSpy).toHaveBeenCalled();
    });
    
    it('should be safe to call multiple times without triggering multiple close events', async () => {
      // Arrange
      const closeSpy = jest.spyOn(mockPort1, 'close');
      
      // Act
      await transport1.close();
      await transport1.close();
      
      // Assert
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
      // Arrange - Additional setup for message handling tests
      onMessageSpy = jest.fn();
      onErrorSpy = jest.fn();
      transport1.onmessage = onMessageSpy;
      transport1.onerror = onErrorSpy;
      await transport1.start();
      await transport2.start();
    });
    
    it('should receive and forward messages from the connected transport', (done) => {
      // Arrange - Already set up in beforeEach
      
      // Act
      transport2.send(validMessage);
      
      // Assert - Using setTimeout to wait for async message delivery
      setTimeout(() => {
        expect(onMessageSpy).toHaveBeenCalledWith(validMessage);
        done();
      }, 10);
    });
    
    it('should trigger onerror when receiving invalid message data', () => {
      // Arrange - Already set up in beforeEach
      
      // Act
      mockPort1.onmessage!({ data: 'not a valid JSON-RPC message' });
      
      // Assert
      expect(onErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Failed to parse message')
      }));
    });
    
    it('should trigger onerror when receiving a messageerror event', () => {
      // Arrange
      const errorEvent = { type: 'messageerror', data: 'some error' };
      
      // Act
      mockPort1.onmessageerror!(errorEvent);
      
      // Assert
      expect(onErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('MessagePort error')
      }));
    });
  });
  
  describe('bidirectional communication', () => {
    it('should support two-way asynchronous communication between transports', (done) => {
      // Arrange
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
      
      // Act
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
      
      // Assert - Function to check results
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
    let channel: MockMessageChannel;
    let parentTransport: BrowserContextTransport;
    
    beforeEach(() => {
      // Arrange - Setup for iframe tests
      mockIframe = new MockIframe();
      channel = new MockMessageChannel();
      
      // Create transport in parent window
      parentTransport = new BrowserContextTransport(channel.port1 as unknown as MessagePort);
    });
    
    it('should facilitate communication between parent window and iframe contexts', (done) => {
      // Arrange
      // 1. Parent context creates channel and transport
      expect(parentTransport).toBeInstanceOf(BrowserContextTransport);
      
      // Act
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
            
            // Assert
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
  
  describe('web worker integration', () => {
    let mockWorker: MockWorker;
    let channel: MockMessageChannel;
    let mainThreadTransport: BrowserContextTransport;
    
    beforeEach(() => {
      // Arrange - Setup for worker tests
      mockWorker = new MockWorker();
      channel = new MockMessageChannel();
      
      // Create transport in main thread
      mainThreadTransport = new BrowserContextTransport(channel.port1 as unknown as MessagePort);
    });
    
    it('should facilitate communication between main thread and worker thread', (done) => {
      // Arrange
      // 1. Main thread creates channel and transport
      expect(mainThreadTransport).toBeInstanceOf(BrowserContextTransport);
      
      // Act
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
            
            // Assert
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