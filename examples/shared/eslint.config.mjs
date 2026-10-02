// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        files: ['src/**/*.{ts,tsx,js,jsx,mts,cts}'],
        rules: {
            // Allow console statements in examples only
            'no-console': 'off',
            // One-way dependency: @mcp-examples/shared is scaffolding consumed BY
            // stories; it must never import FROM a story package.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@mcp-examples/*', '!@mcp-examples/shared', '../../*/**'],
                            message: '@mcp-examples/shared must not import from story packages (one-way dependency).'
                        }
                    ]
                }
            ]
        }
    }
];
