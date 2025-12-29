import { OptionDefaults } from "typedoc";

export default {
    name: "MCP TypeScript SDK",
    entryPointStrategy: "packages",
    entryPoints: ["packages/client", "packages/server"],
    packageOptions: {
        blockTags: [...OptionDefaults.blockTags, "@format"]
    },
    projectDocuments: ["docs/documents.md"],
    navigation: {
        compactFolders: true,
        includeFolders: false,
    },
    headings: {
        readme: false,
    },
};
