import { defineConfig } from 'tsdown';

import { stripDtsSourceMappingUrl } from '../../common/tsdown/stripDtsSourceMappingUrl.mjs';

// core owns the schema source modules (src/schemas.ts, src/auth.ts, src/constants.ts) and builds
// two entries from them:
//   - src/index.ts    → the curated public surface (spec + OAuth `*Schema` constants only)
//   - src/internal.ts → the wholesale internal seam the sibling SDK packages resolve at runtime
// All modules import only `zod/v4`, so the graph stays runtime-neutral; `platform: 'neutral'`
// makes a node-only dependency leaking in fail the build here instead of silently shipping.
export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts', 'src/internal.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'neutral',
    dts: {
        // Declaration maps would reference src/ (and, where bundled, the private
        // core-internal's src/), which is not shipped ("files": ["dist"]); tsc cannot
        // embed sourcesContent into .d.ts maps, so the shipped maps could never resolve
        // on a consumer's machine. Don't emit them (#2233).
        sourcemap: false,
        resolver: 'tsc'
    },
    // Drop the dangling sourceMappingURL comment rolldown leaves on the (map-less) declaration output.
    inputOptions: stripDtsSourceMappingUrl
});
