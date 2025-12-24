import {describe, it, expect, vi, beforeEach} from 'vitest';
import { main } from '../../src/simple-chatbot/multiServerChatbot.js';
import { Configuration } from '../../src/simple-chatbot/Configuration.js';

describe('multi-server chatbot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  
  describe('main', () => {
    it('runs without throwing', async () => {
      await expect(main()).resolves.not.toThrow();
    });
    it('Should ', async () => {
        const loadConfigSpy = vi.spyOn(Configuration, 'loadConfig');
        
        await main();
        expect(loadConfigSpy).toHaveBeenCalled();

    });
  });
});