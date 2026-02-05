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

export default {
    name: 'MCP TypeScript SDK',
    entryPointStrategy: 'packages',
    entryPoints,
    packageOptions: {
        blockTags: [...OptionDefaults.blockTags, '@format']
    },
    projectDocuments: ['docs/documents.md'],
    navigation: {
        compactFolders: true,
        includeFolders: false
    },
    headings: {
        readme: false
    }
};
