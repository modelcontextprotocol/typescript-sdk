// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        // The nested workspace packages (shared, *-quickstart) are linted by their own configs.
        // The one-way "@mcp-examples/shared must not import from stories" rule lives in
        // shared/eslint.config.mjs so it fires under that package's own lint.
        ignores: ['shared/**', 'server-quickstart/**', 'client-quickstart/**']
    },
    {
        files: ['**/*.{ts,tsx,js,jsx,mts,cts}'],
        rules: {
            // Examples write to stdout/stderr deliberately.
            'no-console': 'off',
            // Examples MUST use only what a consumer would `npm install` and import:
            // public package entry points and the @mcp-examples/shared scaffold. Anything
            // reaching into package internals or workspace source is banned.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@modelcontextprotocol/*/src/*', '@modelcontextprotocol/*/dist/*'],
                            message: 'Examples must import only public package entry points (no /src/ or /dist/ deep paths).'
                        },
                        {
                            group: ['**/packages/*', '../../packages/*', '../../../packages/*'],
                            message: 'Examples must not reach into workspace source.'
                        },
                        {
                            group: ['@modelcontextprotocol/core', '@modelcontextprotocol/core/*'],
                            message: 'Examples must import from @modelcontextprotocol/{server,client}, not the internal core barrel.'
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
