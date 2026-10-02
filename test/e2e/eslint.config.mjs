// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        rules: {
            // `await using _ = await wire(...)` holds the connection open for the test body; the binding is intentionally unused
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_$' }],
            // scenario files keep the kebab-case names they share with the v1.x suite
            'unicorn/filename-case': ['error', { cases: { camelCase: true, kebabCase: true } }]
        }
    }
];
