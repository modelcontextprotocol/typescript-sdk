import { defineConfig } from 'tsdown';

// core owns the schema source modules (src/schemas.ts, src/auth.ts, src/constants.ts) and builds
// two entries from them:
//   - src/index.ts    → the curated public surface (spec + OAuth `*Schema` constants only)
//   - src/internal.ts → the wholesale internal seam the sibling SDK packages resolve at runtime
// All modules import only `zod/v4`, so the graph stays runtime-neutral; `platform: 'neutral'`
// makes a node-only dependency leaking in fail the build here instead of silently shipping.
export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts', 'src/internal.ts', 'src/experimental/serverCard/index.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'neutral',
    dts: {
        resolver: 'tsc'
    }
});
