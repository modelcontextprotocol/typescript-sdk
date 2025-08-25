import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Server } from './index.js';
import { JSONRPCMessage, MessageExtraInfo } from '../types.js';
import { Transport } from '../shared/transport.js';

// Mock transport for testing
class MockTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  
  sentMessages: JSONRPCMessage[] = [];
  
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  
  async send(message: JSONRPCMessage): Promise<void> {
    this.sentMessages.push(message);
  }
}

describe('Server Session Integration', () => {
  let server: Server;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  describe('Session Configuration', () => {
    it('should accept session options through constructor', async () => {
      const mockCallback = jest.fn() as jest.MockedFunction<(sessionId: string | number) => void>;
      
      server = new Server(
        { name: 'test-server', version: '1.0.0' },
        {
          sessions: {
            sessionIdGenerator: () => 'test-session-123',
            sessionTimeout: 3600,
            onsessioninitialized: mockCallback,
            onsessionclosed: mockCallback
          }
        }
      );

      await server.connect(transport);
      
      // Verify server was created successfully with session options
      expect(server).toBeDefined();
      expect(server.getTransport()).toBe(transport);
    });

    it('should work without session options', async () => {
      server = new Server(
        { name: 'test-server', version: '1.0.0' }
      );

      await server.connect(transport);
      
      // Should work fine without session configuration
      expect(server).toBeDefined();
      expect(server.getTransport()).toBe(transport);
    });
  });

  describe('Transport Access', () => {
    it('should expose transport via getTransport method', async () => {
      server = new Server(
        { name: 'test-server', version: '1.0.0' }
      );
      await server.connect(transport);

      expect(server.getTransport()).toBe(transport);
    });

    it('should return undefined when not connected', () => {
      server = new Server(
        { name: 'test-server', version: '1.0.0' }
      );

      expect(server.getTransport()).toBeUndefined();
    });
  });

  describe('Session Handler Registration', () => {
    it('should register session terminate handler when created', async () => {
      server = new Server(
        { name: 'test-server', version: '1.0.0' },
        {
          sessions: {
            sessionIdGenerator: () => 'test-session'
          }
        }
      );
      await server.connect(transport);

      // Test that session/terminate handler exists by sending a terminate message
      // and verifying we don't get "method not found" error
      const terminateMessage = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'session/terminate',
        sessionId: 'test-session'
      };

      transport.onmessage!(terminateMessage);
      
      // Check if a "method not found" error was sent
      const methodNotFoundError = transport.sentMessages.find(msg => 
        'error' in msg && msg.error.code === -32601
      );
      
      // Handler should exist, so no "method not found" error
      expect(methodNotFoundError).toBeUndefined();
    });
  });
});