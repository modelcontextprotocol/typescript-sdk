import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: {
        esm: {
            outDir: 'dist/esm'
        },
        cjs: {
            outDir: 'dist/cjs'
        }
    },
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
