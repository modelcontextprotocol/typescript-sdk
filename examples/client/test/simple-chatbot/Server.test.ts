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

        const pid = (server as unknown as { childPid: number | null }).childPid;
        if (pid) {
          process.kill(pid, 'SIGTERM');
        }
      },
      15_000
    );
  });

  describe('listTools', () => {
    it(
      'returns tools from the fake stdio MCP server (will fail until implemented)',
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

        const pid = (server as unknown as { childPid: number | null }).childPid;
        if (pid) {
          process.kill(pid, 'SIGTERM');
        }
      },
      15_000
    );
  });
});
