import { McpServer } from './mcp.js';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import { z } from 'zod';

describe('McpServer outputSchema support', () => {
  let server: McpServer;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    server = new McpServer({ name: 'test', version: '1.0' });
    client = new Client({ name: 'test-client', version: '1.0' });
    
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  describe('tool registration with outputSchema', () => {
    it('should register a tool with outputSchema', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' },
          count: { type: 'number' }
        },
        required: ['result', 'count']
      };

      const tool = server.tool(
        'test-tool',
        'A test tool',
        { input: z.string() },
        outputSchema,
        () => ({ structuredContent: { result: 'test', count: 42 } })
      );

      expect(tool.outputSchema).toEqual(outputSchema);

      // Connect after registering the tool
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    });

    it('should include outputSchema in ListToolsResult', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' }
        }
      };

      server.tool(
        'structured-tool',
        { input: z.string() },
        outputSchema,
        () => ({ structuredContent: { result: 'test' } })
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.listTools();
      expect(result.tools[0].outputSchema).toEqual(outputSchema);
    });
  });

  describe('tool execution with outputSchema', () => {
    it('should return structuredContent and auto-generate content for backward compatibility', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' },
          count: { type: 'number' }
        }
      };

      server.tool(
        'structured-tool',
        { input: z.string() },
        outputSchema,
        () => ({ 
          structuredContent: { result: 'test', count: 42 }
        })
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Need to call listTools first to cache the outputSchema
      await client.listTools();

      const result = await client.callTool({ name: 'structured-tool', arguments: { input: 'test' } });

      expect(result.structuredContent).toEqual({ result: 'test', count: 42 });
      expect(result.content).toEqual([{
        type: 'text',
        text: JSON.stringify({ result: 'test', count: 42 }, null, 2)
      }]);
    });

    it('should preserve both content and structuredContent if tool provides both', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' }
        }
      };

      server.tool(
        'structured-tool',
        { input: z.string() },
        outputSchema,
        () => ({ 
          structuredContent: { result: 'test' },
          content: [{ type: 'text', text: 'Custom text' }]
        })
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Need to call listTools first to cache the outputSchema
      await client.listTools();

      const result = await client.callTool({ name: 'structured-tool', arguments: { input: 'test' } });

      expect(result.structuredContent).toEqual({ result: 'test' });
      expect(result.content).toEqual([{ type: 'text', text: 'Custom text' }]);
    });

    it('should throw error if tool with outputSchema returns no structuredContent', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' }
        }
      };

      server.tool(
        'broken-tool',
        { input: z.string() },
        outputSchema,
        () => ({ 
          content: [{ type: 'text', text: 'No structured content' }]
        })
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Need to call listTools first to cache the outputSchema
      await client.listTools();

      await expect(client.callTool({ name: 'broken-tool', arguments: { input: 'test' } }))
        .rejects.toThrow('has outputSchema but returned no structuredContent');
    });

    it('should throw error if tool without outputSchema returns structuredContent', async () => {
      server.tool(
        'broken-tool',
        { input: z.string() },
        () => ({ 
          structuredContent: { result: 'test' }
        })
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Call listTools first (but in this case the tool has no outputSchema)
      await client.listTools();

      await expect(client.callTool({ name: 'broken-tool', arguments: { input: 'test' } }))
        .rejects.toThrow('has no outputSchema but returned structuredContent');
    });

    it('should handle error results properly for tools with outputSchema', async () => {
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' }
        }
      };

      server.tool(
        'error-tool',
        { input: z.string() },
        outputSchema,
        () => {
          throw new Error('Tool error');
        }
      );

      // Now connect
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // Need to call listTools first to cache the outputSchema
      await client.listTools();

      const result = await client.callTool({ name: 'error-tool', arguments: { input: 'test' } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{
        type: 'text',
        text: 'Tool error'
      }]);
      expect(result.structuredContent).toBeUndefined();
    });
  });
});