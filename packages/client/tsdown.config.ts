import { defineConfig } from 'tsdown';

export default defineConfig({
    failOnWarn: 'ci-only',
    // 1. Entry Points
    //    Directly matches package.json include/exclude globs
    entry: ['src/index.ts', 'src/stdio.ts', 'src/shimsNode.ts', 'src/shimsWorkerd.ts', 'src/shimsBrowser.ts'],

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
                '@modelcontextprotocol/core': ['../core/src/index.ts'],
                '@modelcontextprotocol/core/public': ['../core/src/exports/public/index.ts'],
                '@modelcontextprotocol/core/validators/ajv': ['../core/src/validators/ajvProvider.ts'],
                '@modelcontextprotocol/core/validators/cfWorker': ['../core/src/validators/cfWorkerProvider.ts']
            }
        }
    },
    // 5. Vendoring Strategy - Bundle this package's core implementation into the output,
    //    but treat most dependencies as external (require/import).
    //
    //    The runtime `_shims` entries choose default JSON Schema validators: AJV on Node and
    //    @cfworker/json-schema on workerd/browser. Client users should not have to install a
    //    validator backend just to use the runtime default, so bundle the default backends into
    //    the shim chunks that select them.
    noExternal: ['@modelcontextprotocol/core', 'ajv', 'ajv-formats', '@cfworker/json-schema'],

    // 6. External packages - keep self-reference imports external for runtime resolution
    external: ['@modelcontextprotocol/client/_shims']
});
