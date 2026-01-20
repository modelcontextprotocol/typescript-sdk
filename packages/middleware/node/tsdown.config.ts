import { defineConfig } from 'tsdown';

export default defineConfig({
    // 1. Entry Points
    //    Directly matches package.json include/exclude globs
    entry: ['src/index.ts'],

    // 2. Output Configuration
    format: ['esm'],
    outDir: 'dist',
    clean: true, // Recommended: Cleans 'dist' before building
    sourcemap: true,

    // 3. Platform & Target
    target: 'esnext',
    platform: 'node',
    shims: true, // Polyfills common Node.js shims (__dirname, etc.)

    // 4. Type Definitions
    //    Bundles d.ts files into a single output
    dts: {
        resolver: 'tsc',
        // override just for DTS generation:
        compilerOptions: {
            baseUrl: '.',
            paths: {
                '@modelcontextprotocol/core': ['../core/src/index.ts']
            }
        }
    }
});
