import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Protocol, SessionState } from './protocol.js';
import { ErrorCode, JSONRPCRequest, JSONRPCMessage, Request, Notification, Result, MessageExtraInfo } from '../types.js';
import { Transport } from './transport.js';

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

// Test implementation of Protocol
class TestProtocol extends Protocol<Request, Notification, Result> {
  protected assertCapabilityForMethod(_method: string): void {}
  protected assertNotificationCapability(_method: string): void {}
  protected assertRequestHandlerCapability(_method: string): void {}
  
  // Expose protected methods for testing
  public testValidateSessionId(sessionId?: string | number) {
    return this.validateSessionId(sessionId);
  }
  
  public testCreateSession(sessionId: string | number, timeout?: number) {
    return this.createSession(sessionId, timeout);
  }
  
  public testTerminateSession(sessionId?: string | number) {
    return this.terminateSession(sessionId);
  }
  
  public testUpdateSessionActivity() {
    return this.updateSessionActivity();
  }
  
  public testIsSessionExpired() {
    return this.isSessionExpired();
  }
  
  public getSessionState(): SessionState | undefined {
    return (this as unknown as { _sessionState?: SessionState })._sessionState;
  }
}

describe('Protocol Session Management', () => {
  let protocol: TestProtocol;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  describe('Session Validation', () => {
    it('should allow sessionless operation when no session options', async () => {
      protocol = new TestProtocol();
      await protocol.connect(transport);
      
      // Should validate successfully with no session
      expect(protocol.testValidateSessionId(undefined)).toBe(true);
      expect(protocol.testValidateSessionId('some-session')).toBe(false);
    });

    it('should validate session correctly when enabled', async () => {
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session-123'
        }
      });
      await protocol.connect(transport);
      
      // Create a session
      protocol.testCreateSession('test-session-123');
      
      // Valid session should pass
      expect(protocol.testValidateSessionId('test-session-123')).toBe(true);
      
      // Invalid session should fail
      expect(protocol.testValidateSessionId('wrong-session')).toBe(false);
      
      // No session when one exists should fail
      expect(protocol.testValidateSessionId(undefined)).toBe(false);
    });

    it('should validate sessionless correctly when no active session', async () => {
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session'
        }
      });
      await protocol.connect(transport);
      
      // No active session, no message session = valid
      expect(protocol.testValidateSessionId(undefined)).toBe(true);
      
      // No active session, message has session = invalid
      expect(protocol.testValidateSessionId('some-session')).toBe(false);
    });
  });

  describe('Session Lifecycle', () => {
    it('should create session with correct state', async () => {
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session-123',
          sessionTimeout: 60
        }
      });
      await protocol.connect(transport);
      
      protocol.testCreateSession('test-session-123', 60);
      
      const sessionState = protocol.getSessionState();
      expect(sessionState).toBeDefined();
      expect(sessionState!.sessionId).toBe('test-session-123');
      expect(sessionState!.timeout).toBe(60);
      expect(sessionState!.createdAt).toBeCloseTo(Date.now(), -2);
      expect(sessionState!.lastActivity).toBeCloseTo(Date.now(), -2);
    });

    it('should terminate session correctly', async () => {
      const mockCallback = jest.fn() as jest.MockedFunction<(sessionId: string | number) => void>;
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session-123',
          onsessionclosed: mockCallback
        }
      });
      await protocol.connect(transport);
      
      protocol.testCreateSession('test-session-123');
      expect(protocol.getSessionState()).toBeDefined();
      
      await protocol.testTerminateSession('test-session-123');
      
      expect(protocol.getSessionState()).toBeUndefined();
      expect(mockCallback).toHaveBeenCalledWith('test-session-123');
    });

    it('should reject termination with wrong sessionId', async () => {
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session-123'
        }
      });
      await protocol.connect(transport);
      
      protocol.testCreateSession('test-session-123');
      
      await expect(protocol.testTerminateSession('wrong-session'))
        .rejects.toThrow('Invalid session');
      
      // Session should still exist
      expect(protocol.getSessionState()).toBeDefined();
    });
  });

  describe('Message Handling with Sessions', () => {
    beforeEach(async () => {
      protocol = new TestProtocol({
        sessions: {
          sessionIdGenerator: () => 'test-session'
        }
      });
      await protocol.connect(transport);
      protocol.testCreateSession('test-session');
    });

    it('should reject messages with invalid sessionId', () => {
      const invalidMessage: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
        sessionId: 'wrong-session'
      };

      // Simulate message handling
      transport.onmessage!(invalidMessage);
      
      // Should send error response
      expect(transport.sentMessages).toHaveLength(1);
      const errorMessage = transport.sentMessages[0] as JSONRPCMessage & { error: { code: number } };
      expect(errorMessage.error.code).toBe(ErrorCode.InvalidSession);
    });

    it('should reject sessionless messages when session exists', () => {
      const sessionlessMessage: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1, 
        method: 'test'
        // No sessionId
      };

      transport.onmessage!(sessionlessMessage);
      
      // Should send error response
      expect(transport.sentMessages).toHaveLength(1);
      const errorMessage = transport.sentMessages[0] as JSONRPCMessage & { error: { code: number } };
      expect(errorMessage.error.code).toBe(ErrorCode.InvalidSession);
    });
  });
});