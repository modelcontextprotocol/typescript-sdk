import { OptionDefaults } from 'typedoc';
import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Find all package.json files under packages/ and build package list.
// Exclude node_modules and the codemod batch-test's cloned real-world repos, which are not part
// of this SDK's public API surface (and would otherwise fail docs:check locally when present).
const packageJsonPaths = await fg('packages/**/package.json', {
    cwd: process.cwd(),
    ignore: ['**/node_modules/**', '**/batch-test/**']
});
const packages = packageJsonPaths.map(p => {
    const rootDir = join(process.cwd(), p.replace('/package.json', ''));
    const manifest = JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
    return { rootDir, manifest };
});

// @modelcontextprotocol/core is published for direct schema imports (CallToolResultSchema.parse(...)),
// but it's a thin re-export of the spec/OAuth Zod schemas whose JSDoc cross-references TYPES that live
// in client/server — unresolvable from core's own per-package doc scope. We skip rendering its API docs
// (the schemas mirror the documented types 1:1) so monorepo-wide invalid-link validation can stay ON.
const DOCS_EXCLUDED_PACKAGES = new Set(['@modelcontextprotocol/core']);
const publicPackages = packages.filter(p => p.manifest.private !== true && !DOCS_EXCLUDED_PACKAGES.has(p.manifest.name));
const entryPoints = publicPackages.map(p => p.rootDir);

console.log(
    'Typedoc selected public packages:',
    publicPackages.map(p => p.manifest.name)
);

/** @type {Partial<import("typedoc").TypeDocOptions>} */
export default {
    name: 'MCP TypeScript SDK (V2)',
    entryPointStrategy: 'packages',
    entryPoints,
    packageOptions: {
        blockTags: [...OptionDefaults.blockTags, '@format'],
        exclude: ['**/*.examples.ts']
    },
    highlightLanguages: [...OptionDefaults.highlightLanguages, 'powershell'],
    projectDocuments: ['docs/documents.md', 'packages/middleware/README.md', 'examples/server/README.md', 'examples/client/README.md'],
    hostedBaseUrl: 'https://ts.sdk.modelcontextprotocol.io/v2/',
    navigationLinks: {
        'V1 Docs': '/'
    },
    navigation: {
        compactFolders: true,
        includeFolders: false
    },
    headings: {
        readme: false
    },
    customJs: 'docs/v2-banner.js',
    treatWarningsAsErrors: true,
    out: 'tmp/docs/',
    externalSymbolLinkMappings: {
        '@modelcontextprotocol/core-internal': {
            StandardSchemaV1: 'https://standardschema.dev/',
            StandardJSONSchemaV1: 'https://standardschema.dev/'
        }
    }
};
