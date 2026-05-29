// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import nodePlugin from 'eslint-plugin-n';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        linterOptions: {
            reportUnusedDisableDirectives: false
        },
        plugins: {
            n: nodePlugin
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'n/prefer-node-protocol': 'error'
        }
    },
    {
        ignores: ['src/spec.types.ts']
    },
    {
        files: ['src/client/**/*.ts', 'src/server/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: {
            'no-console': 'error'
        }
    },
    {
        // The e2e suite's `await using _ = await wire(...)` disposal idiom binds a
        // variable solely for its disposer; allow _-prefixed unused variables there.
        files: ['test/e2e/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
        }
    },
    eslintConfigPrettier
);
