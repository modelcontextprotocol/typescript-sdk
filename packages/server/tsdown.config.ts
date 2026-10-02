import { defineConfig } from 'tsdown';

import { stripDtsSourceMappingUrl } from '../../common/tsdown/stripDtsSourceMappingUrl.mjs';

export default defineConfig({
    failOnWarn: 'ci-only',
    entry: [
        'src/index.ts',
        'src/stdio.ts',
        'src/shimsNode.ts',
        'src/shimsWorkerd.ts',
        'src/shimsBrowser.ts',
        'src/validators/ajv.ts',
        'src/validators/cfWorker.ts'
    ],
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
        resolve: ['ajv', 'ajv-formats', 'json-schema-typed'],
        compilerOptions: {
            baseUrl: '.',
            paths: {
                'fast-uri': ['../core-internal/src/validators/fastUriShim.d.ts'],
                '@modelcontextprotocol/core-internal': ['../core-internal/src/index.ts'],
                '@modelcontextprotocol/core-internal/public': ['../core-internal/src/exports/public/index.ts'],
                '@modelcontextprotocol/core-internal/validators/ajv': ['../core-internal/src/validators/ajvProvider.ts'],
                '@modelcontextprotocol/core-internal/validators/cfWorker': ['../core-internal/src/validators/cfWorkerProvider.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal', 'ajv', 'ajv-formats', '@cfworker/json-schema'],
    // The schema modules live in @modelcontextprotocol/core (a real runtime dependency); the
    // bundled core-internal shims import them via the './internal' subpath, which must stay an
    // external import (explicit entry — the tsconfig paths alias would otherwise inline it).
    external: ['@modelcontextprotocol/server/_shims', '@modelcontextprotocol/core/internal'],
    // Drop the dangling sourceMappingURL comment rolldown leaves on the (map-less) declaration output.
    inputOptions: stripDtsSourceMappingUrl
});
