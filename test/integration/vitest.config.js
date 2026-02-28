import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../common/vitest-config/vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
    test: {
        exclude: ['**/dist/**', '**/bun.test.ts', '**/deno.test.ts'],
    },
}));
