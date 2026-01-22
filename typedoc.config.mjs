import { OptionDefaults } from 'typedoc';
import { findWorkspacePackages } from '@pnpm/workspace.find-packages';
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest';

// Read workspace manifest and find all public packages
const workspaceManifest = await readWorkspaceManifest(process.cwd());
const packages = await findWorkspacePackages(process.cwd(), {
    patterns: workspaceManifest?.packages
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
