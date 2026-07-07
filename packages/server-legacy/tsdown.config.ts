import { defineConfig } from 'tsdown';

/**
 * core-internal's two schema source modules (types/schemas.ts + shared/auth.ts) are published
 * verbatim as @modelcontextprotocol/core (see packages/core/tsdown.config.ts). Resolving them to
 * that package at runtime — instead of inlining yet another copy — keeps ONE evaluated copy of
 * the spec + OAuth Zod schema graph per application, however many SDK packages it uses. Safe
 * because core exports every name that crosses this boundary at runtime: SDK-internal helper
 * schemas live in separate core-internal modules (e.g. types/listChangedOptions.ts) and remain
 * bundled, and the remaining internal-only exports of the two modules are imported type-only.
 * Type declarations still inline the types via the dts `paths` mapping — only runtime
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
        resolver: 'tsc',
        compilerOptions: {
            baseUrl: '.',
            paths: {
                '@modelcontextprotocol/core-internal': ['../core-internal/src/index.ts'],
                '@modelcontextprotocol/core-internal/public': ['../core-internal/src/exports/public/index.ts']
            }
        }
    },
    noExternal: ['@modelcontextprotocol/core-internal']
});
