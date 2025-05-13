import http from 'http'; 
import { jest } from '@jest/globals';
import { SSEServerTransport } from './sse.js'; 

const createMockResponse = () => {
  const res = {
    writeHead: jest.fn<http.ServerResponse['writeHead']>(),
    write: jest.fn<http.ServerResponse['write']>().mockReturnValue(true),
    on: jest.fn<http.ServerResponse['on']>(),
    end: jest.fn<http.ServerResponse['end']>(),
  };
  res.writeHead.mockReturnThis();
  res.on.mockReturnThis();
  
  return res as unknown as http.ServerResponse;
};

const createMockRequest = ({ headers = {}, body }: { headers?: Record<string, string>, body?: string } = {}) => {
  const mockReq = {
    headers,
    body: body ? body : undefined,
    auth: {
      token: 'test-token',
    },
    on: jest.fn<http.IncomingMessage['on']>().mockImplementation((event, listener) => {
      const mockListener = listener as unknown as (...args: unknown[]) => void;
      if (event === 'data') {
        mockListener(Buffer.from(body || '') as unknown as Error);
      }
      if (event === 'error') {
        mockListener(new Error('test'));
      }
      if (event === 'end') {
        mockListener();
      }
      if (event === 'close') {
        setTimeout(listener, 100);
      }
      return mockReq;
    }),
    listeners: jest.fn<http.IncomingMessage['listeners']>(),
    removeListener: jest.fn<http.IncomingMessage['removeListener']>(),
  } as unknown as http.IncomingMessage;

  return mockReq;
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

  describe('handlePostMessage method', () => {
    it('should return 500 if server has not started', async () => {
      const mockReq = createMockRequest();
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);

      const error = 'SSE connection not established';
      await expect(transport.handlePostMessage(mockReq, mockRes))
        .rejects.toThrow(error);
      expect(mockRes.writeHead).toHaveBeenCalledWith(500);
      expect(mockRes.end).toHaveBeenCalledWith(error);
    });

    it('should return 400 if content-type is not application/json', async () => {
      const mockReq = createMockRequest({ headers: { 'content-type': 'text/plain' } });
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      await transport.start();

      transport.onerror = jest.fn();
      const error = 'Unsupported content-type: text/plain';
      await expect(transport.handlePostMessage(mockReq, mockRes))
        .resolves.toBe(undefined);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400);
      expect(mockRes.end).toHaveBeenCalledWith(expect.stringContaining(error));
      expect(transport.onerror).toHaveBeenCalledWith(new Error(error));
    });

    it('should return 400 if message has not a valid schema', async () => {
      const invalidMessage = JSON.stringify({
        // missing jsonrpc field
        method: 'call',
        params: [1, 2, 3],
        id: 1,
      })
      const mockReq = createMockRequest({
        headers: { 'content-type': 'application/json' },
        body: invalidMessage,
      });
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      await transport.start();

      transport.onmessage = jest.fn();
      await transport.handlePostMessage(mockReq, mockRes);
      expect(mockRes.writeHead).toHaveBeenCalledWith(400);
      expect(transport.onmessage).not.toHaveBeenCalled();
      expect(mockRes.end).toHaveBeenCalledWith(`Invalid message: ${invalidMessage}`);
    });

    it('should return 202 if message has a valid schema', async () => {
      const validMessage = JSON.stringify({
        jsonrpc: "2.0",
        method: 'call',
        params: {
          a: 1,
          b: 2,
          c: 3,
        },
        id: 1
      })
      const mockReq = createMockRequest({
        headers: { 'content-type': 'application/json' },
        body: validMessage,
      });
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      await transport.start();

      transport.onmessage = jest.fn();
      await transport.handlePostMessage(mockReq, mockRes);
      expect(mockRes.writeHead).toHaveBeenCalledWith(202);
      expect(mockRes.end).toHaveBeenCalledWith('Accepted');
      expect(transport.onmessage).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        method: 'call',
        params: {
          a: 1,
          b: 2,
          c: 3,
        },
        id: 1
      }, {
        authInfo: {
          token: 'test-token',
        }
      });
    });
  });

  describe('close method', () => {
    it('should call onclose', async () => {
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      await transport.start();
      transport.onclose = jest.fn();
      await transport.close();
      expect(transport.onclose).toHaveBeenCalled();
    });
  });

  describe('send method', () => {
    it('should call onsend', async () => {
      const mockRes = createMockResponse();
      const endpoint = '/messages';
      const transport = new SSEServerTransport(endpoint, mockRes);
      await transport.start();
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining('event: endpoint'));
      expect(mockRes.write).toHaveBeenCalledWith(
        expect.stringContaining(`data: /messages?sessionId=${transport.sessionId}`));
    });
  });
});