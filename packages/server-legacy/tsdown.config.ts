import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
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
