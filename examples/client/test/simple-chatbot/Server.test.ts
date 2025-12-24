import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    it('throws "Not implemented" for now', async () => {
      const config: ServerConfigEntry = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      };
      const server = new Server('test-server', config);

      await expect(server.initialize()).rejects.toThrow('Not implemented');
    });
  });
});
