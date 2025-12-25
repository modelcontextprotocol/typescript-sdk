import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Server, type ServerConfigEntry } from '../../src/simple-chatbot/Server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = path.join(__dirname, '..', 'fixtures', 'fake-mcp-server.js');

describe('Server', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates a Server instance with name and config', () => {
      const config: ServerConfigEntry = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      };

      const server = new Server('test-server', config);

      expect(server).toBeInstanceOf(Server);
      expect(server.name).toBe('test-server');
    });
  });

  describe('initialize', () => {
    it(
      'connects to a real stdio MCP server',
      async () => {
        const config: ServerConfigEntry = {
          command: 'node',
          args: [fixture],
        };
        const server = new Server('test-server', config);

        await server.initialize();
        expect(server.childPid).toBeDefined();

        expect((server as unknown as { childPid: number | null }).childPid).not.toBeNull();

        await server.cleanup();
      },
      15_000
    );
  });

  describe('cleanup', () => {
    it('should clean up resources', async () => {
      const config: ServerConfigEntry = {
        command: 'node',
        args: [fixture],
      };
      const server = new Server('test-server', config);

      await server.initialize();
      expect(server.childPid).toBeDefined();

      await server.cleanup();

      const pid = (server as unknown as { childPid: number | null }).childPid;
      if (pid) {
        // Check if process is still running
        let isRunning = true;
        try {
          process.kill(pid, 0);
        } catch {
          isRunning = false;
        }
        expect(isRunning).toBe(false);
      }
    });  
 
    it(
      'serializes concurrent cleanup calls against a real server',
      async () => {
        const server = new Server('test-server', {
          command: 'node',
          args: [fixture],
        });

        await server.initialize();

        // Grab references before cleanup clears them
        const client = server.client;
        const transport = server.transport;

        if (!client || !transport) {
          throw new Error('Server not initialized');
        }

        const clientCloseSpy = vi.spyOn(client, 'close');
        const transportCloseSpy = vi.spyOn(transport, 'close');

        await Promise.all([server.cleanup(), server.cleanup(), server.cleanup(), server.cleanup(), server.cleanup()]);

        expect(clientCloseSpy).toHaveBeenCalledTimes(1);
        // client.close may internally close the transport; our cleanup also closes it.
        // Accept 1-2 calls depending on the transport/client implementation.
        console.log(`transportCloseSpy calls: ${transportCloseSpy.mock.calls.length}`);
        expect(transportCloseSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(transportCloseSpy.mock.calls.length).toBeLessThanOrEqual(2);
        expect(server.client).toBeNull();
        expect(server.transport).toBeNull();
        expect(server.childPid).toBeNull();
      },
      15_000
    );
  });
  describe('listTools', () => {
    it(
      'returns tools from the fake stdio MCP server',
      async () => {
        const server = new Server('tools', {
          command: 'node',
          args: [fixture],
        });

        await server.initialize();
        const tools = await server.listTools();
        expect(tools).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'ping' })])
        );

        const ping = tools.find((t: any) => t.name === 'ping');
        expect(ping?.execution?.taskSupport).toBe('forbidden');

        await server.cleanup();
      },
      15_000
    );
  });
  describe('executeTool', () => {
    it('executes a tool on the fake MCP server', async () => {
      const server = new Server('tools', {
        command: 'node',
        args: [fixture],
      });

      await server.initialize();
      const result = await server.executeTool('ping', { message: 'hi' });

      expect(result).toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ text: 'pong: hi' }),
          ]),
        })
      );

      await server.cleanup();
    });

    it('returns an MCP error when required tool input is missing', async () => {
      const server = new Server('tools', {
        command: 'node',
        args: [fixture],
      });

      await server.initialize();

      const result = await server.executeTool('ping', {});

      expect(result).toEqual(
        expect.objectContaining({
          isError: true,
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('Input validation error'),
            }),
          ]),
        })
      );

      await server.cleanup();
    });
    it('throws an error when executing a tool on uninitialized server', async () => {
      const server = new Server('tools', {
        command: 'node',
        args: [fixture],
      });

      await expect(server.executeTool('ping', { message: 'hi' })).rejects.toThrow(
        `Server tools not initialized`
      );
    });
    it('should retry on failure when executing a tool', async () => {
      const server = new Server('github', {
        command: 'node',
        args: [fixture],
      });

      await server.initialize();

      const callToolSpy = vi.spyOn(server.client as any, 'callTool').mockImplementationOnce(() => {
        throw new Error('Simulated tool execution failure');
      }).mockImplementationOnce(() => {
        return Promise.resolve({
          content: [
            {
              type: 'text',
              text: 'pong: hi'
            }
          ]
        });
      });

      const result = await server.executeTool('ping', { message: 'hi' }, 2, 500);

      expect(callToolSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual(
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ text: 'pong: hi' }),
          ]),
        })
      );

      await server.cleanup();
    });
    it('should throw error after exhausting retries when executing a tool', async () => {
      const server = new Server('tools', {
        command: 'node',
        args: [fixture],
      });

      await server.initialize();

      const callToolSpy = vi.spyOn(server.client as any, 'callTool').mockImplementation(() => {
        throw new Error('Simulated tool execution failure');
      });

      await expect(server.executeTool('ping', { message: 'hi' }, 3, 500)).rejects.toThrow(
        'Simulated tool execution failure'
      );

      expect(callToolSpy).toHaveBeenCalledTimes(3);

      await server.cleanup();
    });
  });
});
