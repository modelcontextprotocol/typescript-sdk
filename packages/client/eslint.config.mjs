// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        settings: {
            'import/internal-regex': '^@modelcontextprotocol/core-internal'
        }
    },
    {
        // Every request in the OAuth client flow (discovery GETs, token and
        // registration POSTs — including the Cross-App Access token exchanges)
        // must pass the URL policy (assertAllowedDiscoveryUrl) before any network
        // I/O. fetchDiscoveryUrl applies it to the initial URL and to every
        // redirect hop, so it is the only place raw fetch calls live.
        files: ['src/client/auth.ts', 'src/client/crossAppAccess.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.name=/^(fetch|fetchFn)$/]:not(FunctionDeclaration[id.name='fetchDiscoveryUrl'] *)",
                    message:
                        'Route OAuth-flow requests through fetchDiscoveryUrl so the URL policy (assertAllowedDiscoveryUrl) and manual redirect handling apply before any request.'
                },
                {
                    selector: "CallExpression[callee.type='LogicalExpression'][callee.left.name='fetchFn'][callee.right.name='fetch']",
                    message:
                        'Direct (fetchFn ?? fetch)(...) calls bypass the URL policy; route the request through fetchDiscoveryUrl instead.'
                }
            ]
        }
    }
];
