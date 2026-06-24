import { defineConfig } from 'tsdown';

// sdk-shared re-exports ONLY the spec Zod schemas from @modelcontextprotocol/core (private,
// unpublished). The core specifier is aliased to core's schemas module (core/src/types/schemas.ts)
// rather than its barrel, so the bundled graph is just the schemas + the constants they use —
// never Protocol, transports, stdio, or the ajv/cfWorker validators. `platform: 'neutral'` keeps
// the output runtime-neutral: a node-only dependency leaking into the graph would fail the build
// here instead of silently shipping.
export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'neutral',
    dts: {
        resolver: 'tsc',
        compilerOptions: {
            baseUrl: '.',
            paths: {
                '@modelcontextprotocol/core': ['../core/src/types/schemas.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core']
});
