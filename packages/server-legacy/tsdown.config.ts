import { defineConfig } from 'tsdown';

import { externalizeCoreSchemas } from '../core-internal/externalizeCoreSchemas.tsdown.mjs';

export default defineConfig({
    failOnWarn: 'ci-only',
    // Resolve the published schema modules from @modelcontextprotocol/core at runtime instead of
    // inlining them — see packages/core-internal/externalizeCoreSchemas.tsdown.mjs for the rationale
    // and the build-time assertions that keep the rewrite honest.
    plugins: [externalizeCoreSchemas()],
    entry: ['src/index.ts', 'src/sse/index.ts', 'src/auth/index.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'node',
    shims: true,
    dts: {
        resolver: 'tsc',
        compilerOptions: {
            baseUrl: '.',
            paths: {
                '@modelcontextprotocol/core-internal': ['../core-internal/src/index.ts'],
                '@modelcontextprotocol/core-internal/public': ['../core-internal/src/exports/public/index.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal']
});
