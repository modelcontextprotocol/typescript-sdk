import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type DefaultTheme } from 'vitepress';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The v1 site's source content (docs + generated API markdown) is populated into docs/v1/content/
 * at build time by scripts/build-docs-site.sh from the v1.x branch. The API Reference sidebar is
 * generated there by typedoc + typedoc-vitepress-theme.
 */
function apiSidebarItems(): DefaultTheme.SidebarItem[] {
    const sidebarPath = resolve(siteDir, 'content/api/typedoc-sidebar.json');
    if (!existsSync(sidebarPath)) {
        console.warn(`[docs/v1] ${sidebarPath} not found — run \`bash scripts/build-docs-site.sh\` to populate the v1 content.`);
        return [];
    }
    return JSON.parse(readFileSync(sidebarPath, 'utf8'));
}

export default defineConfig({
    title: 'MCP TypeScript SDK (v1)',
    description: 'Documentation for v1.x of the MCP TypeScript SDK.',
    base: '/',
    sitemap: { hostname: 'https://ts.sdk.modelcontextprotocol.io' },
    srcDir: 'content',
    markdown: {
        config(md) {
            // Same rewrite as the v2 site: JSDoc carries site-root-relative spec links that are
            // meant to resolve on modelcontextprotocol.io.
            const orig = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
            md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
                const href = tokens[idx].attrGet('href');
                if (href?.startsWith('/specification/')) {
                    tokens[idx].attrSet('href', `https://modelcontextprotocol.io${href}`);
                }
                return orig(tokens, idx, options, env, self);
            };
        }
    },
    themeConfig: {
        nav: [
            { text: 'Guides', link: '/server', activeMatch: '^/(server|client|capabilities|protocol|faq)' },
            { text: 'API Reference', link: '/api/', activeMatch: '^/api/' },
            { text: 'V2 Docs', link: 'https://ts.sdk.modelcontextprotocol.io/v2/' }
        ],
        sidebar: [
            {
                text: 'Guides',
                items: [
                    { text: 'Server', link: '/server' },
                    { text: 'Client', link: '/client' },
                    { text: 'Capabilities', link: '/capabilities' },
                    { text: 'Protocol', link: '/protocol' },
                    { text: 'FAQ', link: '/faq' }
                ]
            },
            {
                text: 'API Reference',
                collapsed: true,
                items: apiSidebarItems()
            }
        ],
        outline: { level: [2, 3] },
        search: { provider: 'local' },
        socialLinks: [{ icon: 'github', link: 'https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x' }]
    }
});
