// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        linterOptions: {
            reportUnusedDisableDirectives: false,
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error",
                { "argsIgnorePattern": "^_" }
            ]
        }
    },
    {
        files: ["src/client/**/*.ts", "src/server/**/*.ts"],
        ignores: ["**/*.test.ts"],
        rules: {
            "no-console": "error"
        }
    }
);
