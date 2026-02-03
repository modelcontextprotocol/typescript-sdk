import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../common/vitest-config/vitest.config.js';

export default mergeConfig(
    baseConfig,
    defineConfig({
        test: {
            // Run test files sequentially to avoid port conflicts and race conditions
            // with process spawning tests (e.g., processCleanup, runtime tests)
            fileParallelism: false
        }
    })
);
