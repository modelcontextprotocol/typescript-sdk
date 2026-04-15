// @ts-check

import baseConfig from '@modelcontextprotocol/eslint-config';

export default [
    ...baseConfig,
    {
        settings: {
            'import/internal-regex': '^@modelcontextprotocol/'
        }
    },
    {
        // This package is the v1-compat surface; deprecated re-exports are intentional.
        // import/no-unresolved: subpaths re-export from sibling packages (server-auth-legacy,
        //   node/sse, server/zod-schemas) that don't exist on this branch standalone — they
        //   land via separate PRs in this BC series. Resolves once those merge.
        // import/export: types.ts deliberately shadows `export *` names with v1-compat aliases
        //   (TS spec: named export wins over re-export).
        // unicorn/filename-case: validation/ajv-provider.ts etc. match v1 subpath names.
        rules: {
            '@typescript-eslint/no-deprecated': 'off',
            'import/no-unresolved': 'off',
            'import/export': 'off',
            'unicorn/filename-case': 'off'
        }
    }
];
