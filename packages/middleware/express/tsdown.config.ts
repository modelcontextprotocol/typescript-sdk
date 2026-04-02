import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts'],
    format: ['esm'],
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
                '@modelcontextprotocol/server': ['../server/src/index.ts']
            }
        }
    }
});
