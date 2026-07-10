import { defineConfig } from 'tsdown';

import { externalizeCoreSchemas } from '../core-internal/externalizeCoreSchemas.tsdown.mjs';

export default defineConfig({
    failOnWarn: 'ci-only',
    // Resolve the published schema modules from @modelcontextprotocol/core at runtime instead of
    // inlining them — see packages/core-internal/externalizeCoreSchemas.tsdown.mjs for the rationale
    // and the build-time assertions that keep the rewrite honest.
    plugins: [externalizeCoreSchemas()],
    entry: [
        'src/index.ts',
        'src/stdio.ts',
        'src/shimsNode.ts',
        'src/shimsWorkerd.ts',
        'src/validators/ajv.ts',
        'src/validators/cfWorker.ts'
    ],
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
        resolve: ['ajv', 'ajv-formats', 'json-schema-typed'],
        compilerOptions: {
            baseUrl: '.',
            paths: {
                'fast-uri': ['../core-internal/src/validators/fastUriShim.d.ts'],
                '@modelcontextprotocol/core-internal': ['../core-internal/src/index.ts'],
                '@modelcontextprotocol/core-internal/public': ['../core-internal/src/exports/public/index.ts'],
                '@modelcontextprotocol/core-internal/validators/ajv': ['../core-internal/src/validators/ajvProvider.ts'],
                '@modelcontextprotocol/core-internal/validators/cfWorker': ['../core-internal/src/validators/cfWorkerProvider.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal', 'ajv', 'ajv-formats', '@cfworker/json-schema'],
    external: ['@modelcontextprotocol/server/_shims']
});
