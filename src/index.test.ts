/**
 * Tests for the main index.ts entry point
 * This validates that the CommonJS/ESM export issue #971 is fixed
 */

import {
  McpError,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  Client,
  Server
} from './index.js';

describe('Main index exports', () => {
  test('should export McpError class', () => {
    expect(McpError).toBeDefined();
    expect(typeof McpError).toBe('function');
    
    // Test that McpError can be instantiated and works correctly
    const error = new McpError(ErrorCode.InvalidRequest, 'Test error');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(ErrorCode.InvalidRequest);
    expect(error.message).toContain('Test error');
  });

  test('should export ErrorCode enum', () => {
    expect(ErrorCode).toBeDefined();
    expect(ErrorCode.InvalidRequest).toBe(-32600);
    expect(ErrorCode.MethodNotFound).toBe(-32601);
    expect(ErrorCode.InternalError).toBe(-32603);
  });

  test('should export protocol version constants', () => {
    expect(LATEST_PROTOCOL_VERSION).toBeDefined();
    expect(typeof LATEST_PROTOCOL_VERSION).toBe('string');
  });

  test('should export Client class', () => {
    expect(Client).toBeDefined();
    expect(typeof Client).toBe('function');
  });

  test('should export Server class', () => {
    expect(Server).toBeDefined();
    expect(typeof Server).toBe('function');
  });

  test('should allow importing McpError from main package - regression test for issue #971', () => {
    // This is the exact import that was failing before the fix
    expect(() => {
      const error = new McpError(ErrorCode.ConnectionClosed, 'Connection lost');
      expect(error.code).toBe(ErrorCode.ConnectionClosed);
    }).not.toThrow();
  });
});