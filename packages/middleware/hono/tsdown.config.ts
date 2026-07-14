import { defineConfig } from 'tsdown';

import { stripDtsSourceMappingUrl } from '../../../common/tsdown/stripDtsSourceMappingUrl.mjs';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    fixedExtension: true,
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    target: 'esnext',
    platform: 'node',
    shims: true,
    dts: {
        // Declaration maps would reference src/ (and, where bundled, the private
        // core-internal's src/), which is not shipped ("files": ["dist"]); tsc cannot
        // embed sourcesContent into .d.ts maps, so the shipped maps could never resolve
        // on a consumer's machine. Don't emit them (#2233).
        sourcemap: false,
        resolver: 'tsc',
        // Keep workspace deps as external imports in the bundled .d.ts instead of
        // inlining their type graph — see ../node/tsdown.config.ts for the rationale.
        compilerOptions: {
            paths: {},
            preserveSymlinks: true
        }
    },
    // Drop the dangling sourceMappingURL comment rolldown leaves on the (map-less) declaration output.
    inputOptions: stripDtsSourceMappingUrl
});
