import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/cli.ts', 'src/index.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'node',
    shims: true,
    dts: {
        resolver: 'tsc'
    }
});
