import { Client } from '@modelcontextprotocol/client';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { Server, type ServerConfigEntry } from '../../src/simple-chatbot/Server.js';

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
    it('connects the client using stdio transport', async () => {
      const config: ServerConfigEntry = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      };
      const server = new Server('test-server', config);
      const connectSpy = vi.spyOn(Client.prototype, 'connect').mockResolvedValue();
      await server.initialize();
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });
  });
});
