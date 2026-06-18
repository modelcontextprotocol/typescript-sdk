// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        // The nested workspace packages (shared, *-quickstart) are linted by their own configs.
        ignores: ['shared/**', 'server-quickstart/**', 'client-quickstart/**']
    },
    {
        files: ['**/*.{ts,tsx,js,jsx,mts,cts}'],
        rules: {
            // Examples write to stdout/stderr deliberately.
            'no-console': 'off',
            // Story client.ts files are self-verifying tests that exit non-zero on failure.
            'unicorn/no-process-exit': 'off',
            // Examples MUST use only what a consumer would `npm install` and import:
            // public package entry points and the local harness. Anything reaching into
            // package internals or workspace source is banned.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        { group: ['@modelcontextprotocol/*/src/*'], message: 'Examples must import only public package entry points.' },
                        {
                            group: ['**/packages/*', '../../packages/*', '../../../packages/*'],
                            message: 'Examples must not reach into workspace source.'
                        },
                        {
                            group: ['@modelcontextprotocol/core', '@modelcontextprotocol/core/*'],
                            message: 'Examples must import from @modelcontextprotocol/{server,client}, not core.'
                        },
                        {
                            group: ['@modelcontextprotocol/test-helpers', '@modelcontextprotocol/test-helpers/*'],
                            message: 'Examples must not depend on test helpers.'
                        }
                    ]
                }
            ]
        }
    }
];
