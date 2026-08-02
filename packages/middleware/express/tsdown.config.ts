import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts', 'src/experimental/serverCardRouter.ts'],
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
        // Keep workspace deps as external imports in the bundled .d.ts instead of
        // inlining their type graph — see ../node/tsdown.config.ts for the rationale.
        compilerOptions: {
            paths: {},
            preserveSymlinks: true
        }
    }
});
