import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: [
        'src/index.ts',
        'src/stdio.ts',
        'src/shimsNode.ts',
        'src/shimsWorkerd.ts',
        'src/validators/ajv.ts',
        'src/validators/cfWorker.ts'
    ],
    format: ['esm'],
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
                'fast-uri': ['../core/src/validators/fastUriShim.d.ts'],
                '@modelcontextprotocol/core': ['../core/src/index.ts'],
                '@modelcontextprotocol/core/public': ['../core/src/exports/public/index.ts'],
                '@modelcontextprotocol/core/validators/ajv': ['../core/src/validators/ajvProvider.ts'],
                '@modelcontextprotocol/core/validators/cfWorker': ['../core/src/validators/cfWorkerProvider.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core', 'ajv', 'ajv-formats', '@cfworker/json-schema'],
    external: ['@modelcontextprotocol/server/_shims']
});
