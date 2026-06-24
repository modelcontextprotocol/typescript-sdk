// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        files: ['**/*.{ts,tsx,js,jsx,mts,cts}'],
        rules: {
            // Conformance fixtures MUST use only what a consumer would `npm install` and import:
            // public package entry points. Anything reaching into core or package internals is banned.
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@modelcontextprotocol/core', '@modelcontextprotocol/core/*'],
                            message: 'Conformance fixtures must import from @modelcontextprotocol/{server,client}, not core.'
                        },
                        {
                            group: ['@modelcontextprotocol/*/src/*'],
                            message: 'Conformance fixtures must import only public package entry points.'
                        },
                        {
                            group: ['@modelcontextprotocol/*/dist/*'],
                            message: 'Conformance fixtures must import only public package entry points.'
                        }
                    ]
                }
            ]
        }
    }
];
