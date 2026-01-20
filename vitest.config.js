import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '@modelcontextprotocol/vitest-config';

/**
 * Root vitest config for workspace-level settings.
 * This config is used when running `vitest run --coverage` from the root.
 * Extends from @modelcontextprotocol/vitest-config with root-specific overrides.
 */
export default mergeConfig(baseConfig, defineConfig({
    test: {
        // Exclude dist directories and non-test packages from test discovery
        exclude: [
            '**/dist/**',
            '**/node_modules/**',
            'common/tsconfig/**',
            'common/vitest-config/**',
            'common/eslint-config/**',
        ],
        coverage: {
            // Override coverage paths for root-level merged report
            include: ['packages/**/src/**/*.ts', 'examples/**/src/**/*.ts'],
            exclude: [
                '**/dist/**',
                '**/node_modules/**',
                '**/*.test.ts',
                '**/*.spec.ts',
                'common/**',
                'test/**',
            ],
        },
    },
}));
