import { defineConfig } from 'tsdown';

/**
 * core-internal's two schema source modules (types/schemas.ts + shared/auth.ts) are published
 * verbatim as @modelcontextprotocol/core (see packages/core/tsdown.config.ts). Resolving them to
 * that package at runtime — instead of inlining yet another copy — keeps ONE evaluated copy of
 * the spec + OAuth Zod schema graph per application, however many SDK packages it uses. Safe
 * because core exports every name that crosses this boundary at runtime: SDK-internal helper
 * schemas live in separate core-internal modules (e.g. types/listChangedOptions.ts) and remain
 * bundled, and the remaining internal-only exports of the two modules are imported type-only.
 * Type declarations still inline the types via the dts `paths` mapping below — only runtime
 * duplication costs.
 */
const CORE_SCHEMA_MODULES = /[\\/]core-internal[\\/]src[\\/](?:types[\\/]schemas|shared[\\/]auth)\.ts$/;

export default defineConfig({
    failOnWarn: 'ci-only',
    plugins: [
        {
            name: 'externalize-core-schemas',
            async resolveId(source, importer, options) {
                if (importer === undefined) return null;
                const resolved = await this.resolve(source, importer, options);
                if (resolved !== null && CORE_SCHEMA_MODULES.test(resolved.id)) {
                    return { id: '@modelcontextprotocol/core', external: true };
                }
                return null;
            }
        }
    ],
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
    external: ['@modelcontextprotocol/client/_shims']
});
