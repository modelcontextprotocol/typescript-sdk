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
        files: ['src/**/*.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        ":matches(CallExpression[callee.property.name='includes'], CallExpression[callee.property.name='indexOf'], " +
                        "CallExpression[callee.property.name='startsWith'])[arguments.0.value='application/json']",
                    message:
                        "Substring-matching 'application/json' misclassifies Content-Type values whose media type is different " +
                        "(e.g. 'text/plain; a=application/json') and mishandles parameters and case. " +
                        'Parse the media type instead: isJsonContentType() from src/shared/mediaType.js.'
                }
            ]
        }
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
