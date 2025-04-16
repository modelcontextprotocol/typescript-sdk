import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client } from '../client/index.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';
import { McpServer } from '../server/mcp.js';
import { StreamableHTTPServerTransport } from '../server/streamableHttp.js';
import { CallToolResultSchema, ListToolsResultSchema, ListResourcesResultSchema, ListPromptsResultSchema } from '../types.js';
import { z } from 'zod';

describe('Streamable HTTP Transport Session Management', () => {
  // Function to set up the server with optional session management
  async function setupServer(withSessionManagement: boolean) {
    const server: Server = createServer();
    const mcpServer = new McpServer(
      { name: 'test-server', version: '1.0.0' },
      {
        capabilities: {
          logging: {},
          tools: {},
          resources: {},
          prompts: {}
        }
      }
    );

    // Add a simple resource
    mcpServer.resource(
      'test-resource',
      '/test',
      { description: 'A test resource' },
      async () => ({
        contents: [{
          uri: '/test',
          text: 'This is a test resource content'
        }]
      })
    );

    mcpServer.prompt(
      'test-prompt',
      'A test prompt',
      async () => ({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: 'This is a test prompt'
          }
        }]
      })
    );

    mcpServer.tool(
      'greet',
      'A simple greeting tool',
      {
        name: z.string().describe('Name to greet').default('World'),
      },
      async ({ name }) => {
        return {
          content: [{ type: 'text', text: `Hello, ${name}!` }]
        };
      }
    );

    // Create transport with or without session management
    const serverTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: withSessionManagement
        ? () => randomUUID()   // With session management, generate UUID
        : () => undefined      // Without session management, return undefined
    });

    await mcpServer.connect(serverTransport);

    server.on('request', async (req, res) => {
      await serverTransport.handleRequest(req, res);
    });

    // Start the server on a random port
    const baseUrl = await new Promise<URL>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        resolve(new URL(`http://127.0.0.1:${addr.port}`));
      });
    });

    return { server, mcpServer, serverTransport, baseUrl };
  }

  describe('Stateless Mode', () => {
    let server: Server;
    let mcpServer: McpServer;
    let serverTransport: StreamableHTTPServerTransport;
    let baseUrl: URL;

    beforeEach(async () => {
      const setup = await setupServer(false);
      server = setup.server;
      mcpServer = setup.mcpServer;
      serverTransport = setup.serverTransport;
      baseUrl = setup.baseUrl;
    });

    afterEach(async () => {
      // Clean up resources
      await mcpServer.close().catch(() => { });
      await serverTransport.close().catch(() => { });
      server.close();
    });

    it('should operate without session management', async () => {
      // Create and connect a client
      const client = new Client({
        name: 'test-client',
        version: '1.0.0'
      });

      const transport = new StreamableHTTPClientTransport(baseUrl);
      await client.connect(transport);

      // Verify that no session ID was set
      expect(transport.sessionId).toBeUndefined();

      // List available tools
      const toolsResult = await client.request({
        method: 'tools/list',
        params: {}
      }, ListToolsResultSchema);

      // Verify tools are accessible
      expect(toolsResult.tools).toContainEqual(expect.objectContaining({
        name: 'greet'
      }));

      // List available resources
      const resourcesResult = await client.request({
        method: 'resources/list',
        params: {}
      }, ListResourcesResultSchema);

      // Verify resources result structure
      expect(resourcesResult).toHaveProperty('resources');

      // List available prompts
      const promptsResult = await client.request({
        method: 'prompts/list',
        params: {}
      }, ListPromptsResultSchema);

      // Verify prompts result structure
      expect(promptsResult).toHaveProperty('prompts');
      expect(promptsResult.prompts).toContainEqual(expect.objectContaining({
        name: 'test-prompt'
      }));

      // Call the greeting tool
      const greetingResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'greet',
          arguments: {
            name: 'Stateless Transport'
          }
        }
      }, CallToolResultSchema);

      // Verify tool result
      expect(greetingResult.content).toEqual([
        { type: 'text', text: 'Hello, Stateless Transport!' }
      ]);

      // Clean up
      await transport.close();
    });
  });

  describe('Stateful Mode', () => {
    let server: Server;
    let mcpServer: McpServer;
    let serverTransport: StreamableHTTPServerTransport;
    let baseUrl: URL;

    beforeEach(async () => {
      const setup = await setupServer(true);
      server = setup.server;
      mcpServer = setup.mcpServer;
      serverTransport = setup.serverTransport;
      baseUrl = setup.baseUrl;
    });

    afterEach(async () => {
      // Clean up resources
      await mcpServer.close().catch(() => { });
      await serverTransport.close().catch(() => { });
      server.close();
    });

    it('should operate with session management', async () => {
      // Create and connect a client
      const client = new Client({
        name: 'test-client',
        version: '1.0.0'
      });

      const transport = new StreamableHTTPClientTransport(baseUrl);
      await client.connect(transport);

      // Verify that a session ID was set
      expect(transport.sessionId).toBeDefined();
      expect(typeof transport.sessionId).toBe('string');

      // List available tools
      const toolsResult = await client.request({
        method: 'tools/list',
        params: {}
      }, ListToolsResultSchema);

      // Verify tools are accessible
      expect(toolsResult.tools).toContainEqual(expect.objectContaining({
        name: 'greet'
      }));

      // List available resources
      const resourcesResult = await client.request({
        method: 'resources/list',
        params: {}
      }, ListResourcesResultSchema);

      // Verify resources result structure
      expect(resourcesResult).toHaveProperty('resources');

      // List available prompts
      const promptsResult = await client.request({
        method: 'prompts/list',
        params: {}
      }, ListPromptsResultSchema);

      // Verify prompts result structure
      expect(promptsResult).toHaveProperty('prompts');
      expect(promptsResult.prompts).toContainEqual(expect.objectContaining({
        name: 'test-prompt'
      }));

      // Call the greeting tool
      const greetingResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'greet',
          arguments: {
            name: 'Stateful Transport'
          }
        }
      }, CallToolResultSchema);

      // Verify tool result
      expect(greetingResult.content).toEqual([
        { type: 'text', text: 'Hello, Stateful Transport!' }
      ]);

      // Clean up
      await transport.close();
    });
  });
});