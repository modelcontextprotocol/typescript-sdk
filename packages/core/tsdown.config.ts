import { defineConfig } from 'tsdown';

// core re-exports ONLY the spec + OAuth Zod schemas from @modelcontextprotocol/core-internal (private,
// unpublished). Two BUILD-ONLY subpath aliases (not real core exports) point at core's two schema
// modules, kept as separate sources:
//   @modelcontextprotocol/core-internal/schemas → core/src/types/schemas.ts   (MCP spec schemas)
//   @modelcontextprotocol/core-internal/auth    → core/src/shared/auth.ts     (OAuth/OpenID schemas)
// Aliasing to these modules rather than core's barrel keeps the bundled graph to just the schemas +
// the constants they use — never Protocol, transports, stdio, or the ajv/cfWorker validators. Both
// modules import only `zod/v4`, so the graph stays runtime-neutral; `platform: 'neutral'` makes a
// node-only dependency leaking in fail the build here instead of silently shipping.
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
                '@modelcontextprotocol/core-internal/schemas': ['../core-internal/src/types/schemas.ts'],
                '@modelcontextprotocol/core-internal/auth': ['../core-internal/src/shared/auth.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal/schemas', '@modelcontextprotocol/core-internal/auth']
});
