import { defineConfig } from 'tsdown';

import { stripDtsSourceMappingUrl } from '../../common/tsdown/stripDtsSourceMappingUrl.mjs';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: ['src/index.ts', 'src/sse/index.ts', 'src/auth/index.ts'],
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
        compilerOptions: {
            baseUrl: '.',
            paths: {
                '@modelcontextprotocol/core-internal': ['../core-internal/src/index.ts'],
                '@modelcontextprotocol/core-internal/public': ['../core-internal/src/exports/public/index.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal'],
    // The schema modules live in @modelcontextprotocol/core (a real runtime dependency); the
    // bundled core-internal shims import them via the './internal' subpath, which must stay an
    // external import (explicit entry — the tsconfig paths alias would otherwise inline it).
    external: ['@modelcontextprotocol/core/internal'],
    // Drop the dangling sourceMappingURL comment rolldown leaves on the (map-less) declaration output.
    inputOptions: stripDtsSourceMappingUrl
});
