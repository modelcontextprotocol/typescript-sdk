import {beforeEach,describe, expect, it, vi} from 'vitest';

import { Configuration } from '../../src/simple-chatbot/Configuration.js';
import { main } from '../../src/simple-chatbot/multiServerChatbot.js';

describe('multi-server chatbot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  
  describe('main', () => {
    it('runs without throwing', async () => {
      await expect(main()).resolves.not.toThrow();
    });
    it('Should call loadConfig', async () => {
        const loadConfigSpy = vi.spyOn(Configuration, 'loadConfig');
        
        await main();
        expect(loadConfigSpy).toHaveBeenCalled();

    });
  });
});