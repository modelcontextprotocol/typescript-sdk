// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        // The nested workspace packages (shared, *-quickstart) are linted by their own configs.
        // The one-way "@mcp-examples/shared must not import from stories" rule lives in
        // shared/eslint.config.mjs so it fires under that package's own lint.
        ignores: ['shared/**', 'server-quickstart/**', 'client-quickstart/**', '**/.wrangler/**']
    },
    {
        // The Workers runtime module exists only inside workerd; wrangler resolves it at
        // deploy time and workerEnv.d.ts declares it for the typechecker.
        files: ['todos-server/worker.ts'],
        rules: { 'import/no-unresolved': ['error', { ignore: ['^cloudflare:'] }] }
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
                            group: ['@modelcontextprotocol/core-internal', '@modelcontextprotocol/core-internal/*'],
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
    },
    {
        // Guide companions are documentation snippets: filenames mirror their page slugs,
        // every //#region must stay self-contained when rendered on its page, and snippet
        // style follows the docs register rather than the example-app style rules.
        // The import restrictions above still apply.
        files: ['guides/**/*.ts'],
        rules: {
            'unicorn/filename-case': 'off',
            'unicorn/switch-case-braces': 'off',
            'unicorn/numeric-separators-style': 'off',
            'unicorn/import-style': 'off',
            'unicorn/no-await-expression-member': 'off',
            'unicorn/prefer-response-static-json': 'off',
            '@typescript-eslint/consistent-type-imports': 'off',
            'simple-import-sort/imports': 'off',
            'import/no-duplicates': 'off',
            'unicorn/require-array-join-separator': 'off',
            'unicorn/explicit-length-check': 'off'
        }
    }
];
