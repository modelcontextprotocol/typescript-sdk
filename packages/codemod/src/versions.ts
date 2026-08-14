import clientPkg from '../../client/package.json';
import corePkg from '../../core/package.json';
import expressPkg from '../../middleware/express/package.json';
import nodePkg from '../../middleware/node/package.json';
import serverPkg from '../../server/package.json';
import serverLegacyPkg from '../../server-legacy/package.json';

/**
 * Caret ranges for the v2 packages the codemod writes into migrated package.json
 * files. Versions come straight from the workspace manifests — the bundler inlines
 * them at build time — so a release bump can never leave this map stale.
 */
export const V2_PACKAGE_VERSIONS: Record<string, string> = {
    '@modelcontextprotocol/client': `^${clientPkg.version}`,
    '@modelcontextprotocol/server': `^${serverPkg.version}`,
    '@modelcontextprotocol/node': `^${nodePkg.version}`,
    '@modelcontextprotocol/express': `^${expressPkg.version}`,
    '@modelcontextprotocol/server-legacy': `^${serverLegacyPkg.version}`,
    '@modelcontextprotocol/core': `^${corePkg.version}`
};
