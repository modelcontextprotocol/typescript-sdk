// Shared tsdown build plugin. Plain .mjs (not .ts) because tsdown's config loader transpiles only
// the entry tsdown.config.ts itself and native-imports everything else, and Node 20 cannot import
// TypeScript sources. Types for consumers live in externalizeCoreSchemas.tsdown.d.mts.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * core-internal's two schema source modules are published verbatim as @modelcontextprotocol/core (see
 * packages/core/tsdown.config.ts). The externalizeCoreSchemas() tsdown plugin rewrites every import that RESOLVES to
 * one of them — whatever the import specifier looked like — into an external import of '@modelcontextprotocol/core',
 * so built packages resolve the schemas from that package at runtime instead of inlining yet another copy. That keeps
 * ONE evaluated copy of the spec + OAuth Zod schema graph per application, however many SDK packages it uses.
 *
 * Safe because core exports every name that crosses this boundary at runtime: SDK-internal helper schemas live in
 * separate core-internal modules (e.g. types/listChangedOptions.ts) and remain bundled, and the remaining
 * internal-only exports of the two modules are imported type-only (client's externalizedCoreBoundary.test.ts checks
 * the built output against core's real export surface). Type declarations still inline the types via each consumer's
 * dts `paths` mapping — only runtime duplication costs.
 *
 * @type {readonly string[]}
 */
export const CORE_SCHEMA_MODULES = [
    path.join(HERE, 'src', 'types', 'schemas.ts'), // MCP spec schemas
    path.join(HERE, 'src', 'shared', 'auth.ts') // OAuth/OpenID schemas
];

const CORE_INTERNAL_SRC = path.join(HERE, 'src') + path.sep;

/**
 * Resolvers may decorate an id beyond the plain file path (`\0` virtual-module prefix, `?query` suffix).
 *
 * @param {string} id
 * @returns {string}
 */
function undecorate(id) {
    return id.replace(/^\0/, '').replace(/\?.*$/, '');
}

/**
 * Rewrites imports of {@link CORE_SCHEMA_MODULES} to external '@modelcontextprotocol/core' imports, and fails the
 * build when the rewrite cannot have worked, in both directions:
 *
 * - a listed module that does not exist on disk, or is never rewritten by a build that emits runtime chunks bundling
 *   core-internal sources, fails the build — otherwise renaming or moving a schema module would silently re-inline
 *   the whole schema graph into every consumer;
 * - a listed module that still ends up in an emitted runtime chunk fails the build — the rewrite was bypassed, e.g.
 *   by a resolver id decoration the comparison does not recognize.
 *
 * The checks look at emitted runtime chunks (.mjs/.cjs), not the raw module graph, because the d.ts pass loads the
 * schema .ts sources on purpose: type declarations inline the types via each consumer's dts `paths` mapping.
 *
 * @returns {import('tsdown').Rolldown.Plugin}
 */
export function externalizeCoreSchemas() {
    const rewrites = new Map(CORE_SCHEMA_MODULES.map(module => [module, 0]));
    return {
        name: 'externalize-core-schemas',
        buildStart() {
            for (const module of CORE_SCHEMA_MODULES) {
                if (!existsSync(module)) {
                    this.error(
                        `externalize-core-schemas: listed schema module ${module} does not exist. ` +
                            `If it moved, update CORE_SCHEMA_MODULES in packages/core-internal/externalizeCoreSchemas.tsdown.mjs ` +
                            `and the aliases in packages/core/tsdown.config.ts, which publish the same modules.`
                    );
                }
            }
        },
        async resolveId(source, importer, options) {
            if (importer === undefined) return null;
            const resolved = await this.resolve(source, importer, options);
            if (resolved === null) return null;
            const id = path.normalize(undecorate(resolved.id));
            const count = rewrites.get(id);
            if (count === undefined) return null;
            rewrites.set(id, count + 1);
            return { id: '@modelcontextprotocol/core', external: true };
        },
        generateBundle(_outputOptions, bundle) {
            const bundledIds = new Set(
                Object.values(bundle)
                    .filter(output => output.type === 'chunk' && !/\.d\.[cm]?ts$/.test(output.fileName))
                    .flatMap(chunk => chunk.moduleIds.map(id => path.normalize(undecorate(id))))
            );
            // Outputs with no core-internal runtime code (e.g. the d.ts pass) prove nothing about the rewrite.
            if (![...bundledIds].some(id => id.startsWith(CORE_INTERNAL_SRC))) return;
            const missed = CORE_SCHEMA_MODULES.filter(module => rewrites.get(module) === 0);
            if (missed.length > 0) {
                this.error(
                    `externalize-core-schemas: no import resolved to ${missed.join(' or ')}, ` +
                        `so nothing was externalized from there and the schema graph would be inlined. ` +
                        `If the module was renamed or split, update CORE_SCHEMA_MODULES in ` +
                        `packages/core-internal/externalizeCoreSchemas.tsdown.mjs and packages/core/tsdown.config.ts.`
                );
            }
            const inlined = CORE_SCHEMA_MODULES.filter(module => bundledIds.has(module));
            if (inlined.length > 0) {
                this.error(
                    `externalize-core-schemas: ${inlined.join(' and ')} reached an emitted runtime chunk ` +
                        `despite being listed for externalization — the resolveId rewrite was bypassed.`
                );
            }
        }
    };
}
