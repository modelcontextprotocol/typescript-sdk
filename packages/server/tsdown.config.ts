import { defineConfig } from 'tsdown';

export default defineConfig({
    // 1. Entry Points
    //    Directly matches package.json include/exclude globs
    entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__mocks__/**', '!src/examples/**'],

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
    dts: true,

    // 5. CRITICAL: Vendoring Strategy
    //    This tells tsdown: "Bundle the code for this specific package into the output,
    //    but treat all other dependencies as external (require/import)."
    noExternal: ['@modelcontextprotocol/sdk-core']
});
