import { OptionDefaults } from 'typedoc';
import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Find all package.json files under packages/ and build package list
const packageJsonPaths = await fg('packages/**/package.json', {
    cwd: process.cwd(),
    ignore: ['**/node_modules/**']
});
const packages = packageJsonPaths.map(p => {
    const rootDir = join(process.cwd(), p.replace('/package.json', ''));
    const manifest = JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));
    return { rootDir, manifest };
});

const publicPackages = packages.filter(p => p.manifest.private !== true);
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
    projectDocuments: [
        'docs/documents.md',
        'packages/middleware/README.md',
        'examples/server/README.md',
        'examples/client/README.md',
    ],
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
};
