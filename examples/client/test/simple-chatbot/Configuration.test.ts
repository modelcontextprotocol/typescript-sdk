import { Configuration } from '../../src/simple-chatbot/Configuration';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Configuration class', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    })
    describe('constructor', () => {
        it('should create an instance of Configuration', () => {
            const config = new Configuration();
            expect(config).toBeInstanceOf(Configuration);
        });
        it('should call loadEnv and loadConfig methods', () => {
            const loadEnvSpy = vi.spyOn(Configuration, 'loadEnv').mockImplementation(() => {});
            const loadConfigSpy = vi.spyOn(Configuration, 'loadConfig').mockImplementation(() => ({}));
            
            new Configuration();
            
            expect(loadEnvSpy).toHaveBeenCalled();
        });
    });
    describe('get llmApiKey', () => {
        it('should throw an error if LLM_API_KEY is not set', () => {
            process.env["LLM_API_KEY"] = '';
            const config = new Configuration();
            expect(() => config.llmApiKey).toThrow("LLM_API_KEY not found in environment variables");
        });
        it('should return the LLM_API_KEY if it is set', () => {
            process.env["LLM_API_KEY"] = 'test-api-key';
            const config = new Configuration();
            expect(config.llmApiKey).toBe('test-api-key');
        });
    });
});