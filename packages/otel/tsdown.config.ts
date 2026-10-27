import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'neutral',
    dts: {
        resolver: 'tsc',
        compilerOptions: {
            paths: {},
            preserveSymlinks: true
        }
    },
    external: ['@opentelemetry/api']
});
