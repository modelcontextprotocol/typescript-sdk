// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import nodePlugin from 'eslint-plugin-n';
import simpleImportSortPlugin from 'eslint-plugin-simple-import-sort';
import { configs } from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
    eslint.configs.recommended,
    ...configs.recommended,
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    {
        languageOptions: {
            parserOptions: {
                // Ensure consumers of this shared config get a stable tsconfig root
                tsconfigRootDir: __dirname
            }
        },
        linterOptions: {
            reportUnusedDisableDirectives: false
        },
        plugins: {
            n: nodePlugin,
            'simple-import-sort': simpleImportSortPlugin
        },
        settings: {
            'import/resolver': {
                typescript: {
                    // Let the TS resolver handle NodeNext-style imports like "./foo.js"
                    extensions: ['.js', '.jsx', '.ts', '.tsx', '.d.ts'],
                    // Use the tsconfig in each package root (when running ESLint from that package)
                    project: 'tsconfig.json'
                }
            }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'n/prefer-node-protocol': 'error',
            '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
            'simple-import-sort/imports': 'warn',
            'simple-import-sort/exports': 'warn',
            'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
            'import/no-extraneous-dependencies': [
                'error',
                {
                    devDependencies: [
                        '**/test/**',
                        '**/*.test.ts',
                        '**/*.test.tsx',
                        '**/scripts/**',
                        '**/vitest.config.*',
                        '**/tsdown.config.*',
                        '**/eslint.config.*',
                        '**/vitest.setup.*'
                    ],
                    optionalDependencies: false,
                    peerDependencies: true
                }
            ]
        }
    },
    {
        // Ignore generated protocol types everywhere
        ignores: ['**/spec.types.ts']
    },
    {
        files: ['packages/client/**/*.ts', 'packages/server/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: {
            'no-console': 'error'
        }
    },
    eslintConfigPrettier
);
