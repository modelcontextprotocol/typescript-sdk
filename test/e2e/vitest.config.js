import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from '../../common/vitest-config/vitest.config.js';

export default mergeConfig(
    baseConfig,
    defineConfig({
        test: {
            // The e2e suite keeps its test files at the package root (coverage.test.ts,
            // scenarios/*.test.ts, helpers/*.test.ts) rather than under test/.
            include: ['**/*.test.ts'],
            exclude: ['**/node_modules/**', '**/dist/**'],
            // Applies the draft-vocabulary leak assertion to global-fetch
            // exchanges (hosting scenarios that bypass the wire() helpers).
            setupFiles: ['./helpers/leak-setup.ts']
        }
    })
);
