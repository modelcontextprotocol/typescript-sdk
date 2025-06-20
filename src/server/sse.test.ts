import http from 'http'; 
import { jest } from '@jest/globals';
import { SSEServerTransport } from './sse.js';
import { AuthInfo } from './auth/types.js'; 

const createMockResponse = () => {
  const res = {
    writeHead: jest.fn<http.ServerResponse['writeHead']>(),
    write: jest.fn<http.ServerResponse['write']>().mockReturnValue(true),
    on: jest.fn<http.ServerResponse['on']>(),
    end: jest.fn<http.ServerResponse['end']>().mockReturnThis(),
  };
  res.writeHead.mockReturnThis();
  res.on.mockReturnThis();
  
  return res as unknown as http.ServerResponse;
};

const createMockRequest = (headers: Record<string, string> = {}) => {
  return {
    headers,
  } as unknown as http.IncomingMessage & { auth?: AuthInfo };
};

describe('SSEServerTransport', () => {
  describe('start method', () => { 
    it('should correctly append sessionId to a simple relative endpoint', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with existing query parameters', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages?foo=bar&baz=qux';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?foo=bar&baz=qux&sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with a hash fragment', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages#section1';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?sessionId=${expectedSessionId}#section1\n\n`
      );
    });

    it('should correctly append sessionId to an endpoint with query parameters and a hash fragment', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/messages?key=value#section2';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /messages?key=value&sessionId=${expectedSessionId}#section2\n\n`
      );
    });

    it('should correctly handle the root path endpoint "/"', async () => { 
      const mockRes = createMockResponse();
      const endpoint = '/';
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`
      );
    });

    it('should correctly handle an empty string endpoint ""', async () => { 
      const mockRes = createMockResponse();
      const endpoint = ''; 
      const transport = new SSEServerTransport(endpoint, mockRes);
      const expectedSessionId = transport.sessionId;

      await transport.start();

      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        `event: endpoint\ndata: /?sessionId=${expectedSessionId}\n\n`
      );
    });
  });

  describe('DNS rebinding protection', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    describe('Host header validation', () => {
      it('should accept requests with allowed host headers', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedHosts: ['localhost:3000', 'example.com'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        const mockReq = createMockRequest({
          host: 'localhost:3000',
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
      });

      it('should reject requests with disallowed host headers', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedHosts: ['localhost:3000'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        const mockReq = createMockRequest({
          host: 'evil.com',
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Host header: evil.com');
      });

      it('should reject requests without host header when allowedHosts is configured', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedHosts: ['localhost:3000'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        const mockReq = createMockRequest({
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Host header: undefined');
      });
    });

    describe('Origin header validation', () => {
      it('should accept requests with allowed origin headers', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedOrigins: ['http://localhost:3000', 'https://example.com'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        const mockReq = createMockRequest({
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
      });

      it('should reject requests with disallowed origin headers', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedOrigins: ['http://localhost:3000'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        const mockReq = createMockRequest({
          origin: 'http://evil.com',
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(403);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');
      });
    });

    describe('Content-Type validation', () => {
      it('should accept requests with application/json content-type', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes);
        await transport.start();

        const mockReq = createMockRequest({
          'content-type': 'application/json',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
      });

      it('should accept requests with application/json with charset', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes);
        await transport.start();

        const mockReq = createMockRequest({
          'content-type': 'application/json; charset=utf-8',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(202);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Accepted');
      });

      it('should reject requests with non-application/json content-type when protection is enabled', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes);
        await transport.start();

        const mockReq = createMockRequest({
          'content-type': 'text/plain',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(400);
        expect(mockHandleRes.end).toHaveBeenCalledWith('Error: Unsupported content-type: text/plain');
      });
    });

    describe('enableDnsRebindingProtection option', () => {
      it('should skip all validations when enableDnsRebindingProtection is false', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedHosts: ['localhost:3000'],
          allowedOrigins: ['http://localhost:3000'],
          enableDnsRebindingProtection: false,
        });
        await transport.start();

        const mockReq = createMockRequest({
          host: 'evil.com',
          origin: 'http://evil.com',
          'content-type': 'text/plain',
        });
        const mockHandleRes = createMockResponse();

        await transport.handlePostMessage(mockReq, mockHandleRes, { jsonrpc: '2.0', method: 'test' });

        // Should pass even with invalid headers because protection is disabled
        expect(mockHandleRes.writeHead).toHaveBeenCalledWith(400);
        // The error should be from content-type parsing, not DNS rebinding protection
        expect(mockHandleRes.end).toHaveBeenCalledWith('Error: Unsupported content-type: text/plain');
      });
    });

    describe('Combined validations', () => {
      it('should validate both host and origin when both are configured', async () => {
        const mockRes = createMockResponse();
        const transport = new SSEServerTransport('/messages', mockRes, {
          allowedHosts: ['localhost:3000'],
          allowedOrigins: ['http://localhost:3000'],
          enableDnsRebindingProtection: true,
        });
        await transport.start();

        // Valid host, invalid origin
        const mockReq1 = createMockRequest({
          host: 'localhost:3000',
          origin: 'http://evil.com',
          'content-type': 'application/json',
        });
        const mockHandleRes1 = createMockResponse();

        await transport.handlePostMessage(mockReq1, mockHandleRes1, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes1.writeHead).toHaveBeenCalledWith(403);
        expect(mockHandleRes1.end).toHaveBeenCalledWith('Invalid Origin header: http://evil.com');

        // Invalid host, valid origin
        const mockReq2 = createMockRequest({
          host: 'evil.com',
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        });
        const mockHandleRes2 = createMockResponse();

        await transport.handlePostMessage(mockReq2, mockHandleRes2, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes2.writeHead).toHaveBeenCalledWith(403);
        expect(mockHandleRes2.end).toHaveBeenCalledWith('Invalid Host header: evil.com');

        // Both valid
        const mockReq3 = createMockRequest({
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
        });
        const mockHandleRes3 = createMockResponse();

        await transport.handlePostMessage(mockReq3, mockHandleRes3, { jsonrpc: '2.0', method: 'test' });

        expect(mockHandleRes3.writeHead).toHaveBeenCalledWith(202);
        expect(mockHandleRes3.end).toHaveBeenCalledWith('Accepted');
      });
    });
  });
});
