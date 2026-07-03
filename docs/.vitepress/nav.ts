import type { DefaultTheme } from 'vitepress';

/**
 * The guide sidebar: every hand-written page, in reading order. Shared by the
 * site config (which appends the generated API Reference group) and the
 * llms.txt generator (which mirrors these groups and this order).
 */
export const guideSidebar: DefaultTheme.SidebarItem[] = [
    {
        text: 'Get started',
        items: [
            { text: 'Build a server', link: '/get-started/first-server' },
            { text: 'Plug into a real host', link: '/get-started/real-host' },
            { text: 'Build a client', link: '/get-started/first-client' },
            { text: 'Packages', link: '/get-started/packages' },
            { text: 'Examples', link: '/get-started/examples' }
        ]
    },
    {
        text: 'Servers',
        items: [
            { text: 'Tools', link: '/servers/tools' },
            { text: 'Resources', link: '/servers/resources' },
            { text: 'Prompts', link: '/servers/prompts' },
            { text: 'Completion', link: '/servers/completion' },
            { text: 'Logging, progress, cancellation', link: '/servers/logging-progress-cancellation' },
            { text: 'Elicitation', link: '/servers/elicitation' },
            { text: 'Sampling (sunset)', link: '/servers/sampling' },
            { text: 'Input required', link: '/servers/input-required' },
            { text: 'Notifications', link: '/servers/notifications' },
            { text: 'Errors', link: '/servers/errors' }
        ]
    },
    {
        text: 'Serving',
        items: [
            { text: 'stdio', link: '/serving/stdio' },
            { text: 'HTTP', link: '/serving/http' },
            { text: 'Express', link: '/serving/express' },
            { text: 'Hono', link: '/serving/hono' },
            { text: 'Fastify', link: '/serving/fastify' },
            { text: 'Web-standard runtimes', link: '/serving/web-standard' },
            { text: 'Sessions, state, scaling', link: '/serving/sessions-state-scaling' },
            { text: 'Authorization', link: '/serving/authorization' },
            { text: 'External authorization servers', link: '/serving/external-authorization-servers' },
            { text: 'Legacy clients', link: '/serving/legacy-clients' }
        ]
    },
    {
        text: 'Clients',
        items: [
            { text: 'Connect', link: '/clients/connect' },
            { text: 'Calling', link: '/clients/calling' },
            { text: 'Handle server requests', link: '/clients/server-requests' },
            { text: 'Roots (sunset)', link: '/clients/roots' },
            { text: 'Subscriptions', link: '/clients/subscriptions' },
            { text: 'OAuth', link: '/clients/oauth' },
            { text: 'Machine auth', link: '/clients/machine-auth' },
            { text: 'Middleware', link: '/clients/middleware' },
            { text: 'Caching', link: '/clients/caching' }
        ]
    },
    { text: 'Protocol versions', link: '/protocol-versions' },
    {
        text: 'Advanced',
        collapsed: true,
        items: [
            { text: 'Low-level server', link: '/advanced/low-level-server' },
            { text: 'Custom methods', link: '/advanced/custom-methods' },
            { text: 'Schema libraries', link: '/advanced/schema-libraries' },
            { text: 'Custom transports', link: '/advanced/custom-transports' },
            { text: 'Wire schemas', link: '/advanced/wire-schemas' },
            { text: 'Gateway', link: '/advanced/gateway' }
        ]
    },
    { text: 'Testing', link: '/testing' },
    { text: 'Troubleshooting', link: '/troubleshooting' },
    {
        text: 'Migration',
        items: [
            { text: 'Overview', link: '/migration/' },
            { text: 'Upgrade to v2', link: '/migration/upgrade-to-v2' },
            { text: '2026-07-28 protocol support', link: '/migration/support-2026-07-28' }
        ]
    }
];
