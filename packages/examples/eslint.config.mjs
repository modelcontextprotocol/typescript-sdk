// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        files: ['src/**/*.{ts,tsx,js,jsx,mts,cts}'],
        rules: {
            // Allow console statements in examples only
            'no-console': 'off'
        }
    }
];
