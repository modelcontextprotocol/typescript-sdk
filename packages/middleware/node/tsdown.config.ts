import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
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
        // The dev tsconfig.json maps @modelcontextprotocol/* to workspace source via
        // `paths` so typecheck/IDE work without a prior build. For declaration emit we
        // need the opposite: resolve workspace deps through node_modules and keep them
        // as *external* imports in the bundled .d.ts (server is a peerDependency, so
        // consumers already have its types). `paths: {}` disables the dev source
        // mappings; `preserveSymlinks` keeps `node_modules` in the resolved path so
        // rolldown-plugin-dts recognises the dep as external instead of inlining the
        // whole upstream type graph (which OOMs once core's surface gets large enough).
        compilerOptions: {
            paths: {},
            preserveSymlinks: true
        }
    }
});
