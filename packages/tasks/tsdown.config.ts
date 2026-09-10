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
        // Keep workspace deps as external imports in the bundled .d.ts instead of
        // inlining their type graph — see ../middleware/hono/tsdown.config.ts.
        compilerOptions: {
            paths: {},
            preserveSymlinks: true
        }
    }
});
